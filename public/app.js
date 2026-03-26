/**
 * Blitz – app.js
 * Vanilla JS frontend: section selector, question fetching, rendering,
 * keyboard navigation, and session state.
 */

(function () {
  "use strict";

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const splashScreen    = document.getElementById("splash");
  const practiceScreen  = document.getElementById("practice");
  const startBtn        = document.getElementById("start-btn");
  const backBtn         = document.getElementById("back-btn");
  const nextBtn         = document.getElementById("next-btn");
  const emptyBackBtn    = document.getElementById("empty-back-btn");
  const checkboxes      = Array.from(document.querySelectorAll(".check-item input[type='checkbox']"));
  const selectionError  = document.getElementById("selection-error");
  const loadingOverlay  = document.getElementById("loading-overlay");
  const emptyOverlay    = document.getElementById("empty-overlay");

  const questionCounter   = document.getElementById("question-counter");
  const accuracyDisplay   = document.getElementById("accuracy-display");
  const questionCard      = document.getElementById("question-card");
  const questionCode      = document.getElementById("question-code");
  const maxMarkEl         = document.getElementById("max-mark");
  const questionText      = document.getElementById("question-text");
  const choicesList       = document.getElementById("choices-list");
  const markschemeSection = document.getElementById("markscheme-section");
  const answerDisplay     = document.getElementById("answer-display");
  const markschemeText    = document.getElementById("markscheme-text");

  // ── Session state ──────────────────────────────────────────────────────────
  let questions         = [];   // All loaded questions
  let queue             = [];   // Shuffled indices
  let currentIndex      = 0;    // Position in queue
  let markschemeVisible = false;

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Fisher-Yates shuffle (returns new array) */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showOverlay(el) { el.hidden = false; }
  function hideOverlay(el) { el.hidden = true; }

  function showScreen(screen) {
    [splashScreen, practiceScreen].forEach((s) => {
      s.classList.remove("active");
    });
    // Tiny rAF so the browser registers the class removal before re-adding
    requestAnimationFrame(() => {
      screen.classList.add("active");
    });
  }

  // ── Client-side parser (fallback if worker unavailable) ───────────────────
  /**
   * Parse a raw question object on the client side.
   * Mirrors the server-side logic in worker.js.
   */
  function parseQuestion(raw) {
    const scraped = raw.scraped || "";

    // Extract max mark from "[Maximum mark: X]" (may use non-breaking spaces)
    const maxMarkMatch = scraped.match(/\[Maximum[\s\u00a0]mark:[\s\u00a0]*(\d+)\]/i);
    const maxMark = maxMarkMatch ? parseInt(maxMarkMatch[1], 10) : null;

    const choiceRegex = /(?=\bA\.|\bB\.|\bC\.|\bD\.)/;
    const parts = scraped.split(choiceRegex);

    let questionText = (parts[0] || raw.question || "").trim();

    // Strip markscheme section (bleeds in for non-MCQ questions)
    questionText = questionText.replace(/\n?Markscheme[\s\S]*/i, "").trim();

    // Strip preamble: everything up to and including the question ID line
    if (raw.number) {
      const escapedId = raw.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      questionText = questionText.replace(new RegExp(`^[\\s\\S]*?${escapedId}\\s*\\n?`), "");
    }

    // Strip part indicator at start like "(a)", "(a(ii))", "(b(iii))"
    questionText = questionText.replace(/^\s*\([a-z]\d*(?:\([ivxlcdm]+\))?\)\s*/i, "");

    // Strip [N] mark indicators like "[2]"
    questionText = questionText.replace(/\[\d+\]/g, "");

    // Clean up whitespace
    questionText = questionText.replace(/\n+/g, " ").trim();

    const choices = [];
    for (let i = 1; i < parts.length; i++) {
      const segment = parts[i].trim();
      if (/^Markscheme/i.test(segment)) break;
      const clean = segment.replace(/\n?Markscheme[\s\S]*/i, "").trim();
      if (/^[A-D]\.\s*/.test(clean)) choices.push(clean);
    }

    const answerMatch = scraped.match(/Markscheme\s*\n\s*([A-D])\b/i);
    const answer = answerMatch ? answerMatch[1].toUpperCase() : "";

    let markscheme = "";
    const msMatch = scraped.match(/Markscheme\s*\n\s*[A-D]\s*\n([\s\S]*)/i);
    if (msMatch) {
      markscheme = msMatch[1].trim();
    } else {
      const msRaw = scraped.match(/Markscheme\s*\n([\s\S]*)/i);
      if (msRaw) markscheme = msRaw[1].trim();
    }

    // Strip examiners report from markscheme (may appear at start or after newline)
    markscheme = markscheme.replace(/(^|\n)\s*Examiners\s+report[\s\S]*/i, "").trim();

    return {
      number: raw.number || "",
      questionText,
      choices,
      answer,
      markscheme,
      maxMark,
    };
  }

  // ── Multipart grouping helpers ─────────────────────────────────────────────

  function getBaseId(number) {
    const segs = number.split(".");
    const last = segs[segs.length - 1];

    if (/^x{0,3}(?:ix|iv|v?i{0,3})$/i.test(last) && last !== "") {
      const prefix = segs.slice(0, -1);
      const prevLast = prefix[prefix.length - 1];
      const baseOfPrev = (prevLast.match(/^(\d*)/) || ["", ""])[1];
      if (baseOfPrev) return prefix.slice(0, -1).concat(baseOfPrev).join(".");
      return prefix.slice(0, -1).join(".");
    }

    if (/[a-z]/i.test(last)) {
      const baseOfLast = (last.match(/^(\d*)/) || ["", ""])[1];
      if (baseOfLast) return segs.slice(0, -1).concat(baseOfLast).join(".");
      return segs.slice(0, -1).join(".");
    }

    return null;
  }

  function getPartLabel(number, baseId) {
    let part = number.slice(baseId.length);
    if (part.startsWith(".")) part = part.slice(1);
    part = part.replace(/\.(x{0,3}(?:ix|iv|v?i{0,3}))$/i, "($1)");
    return part || number;
  }

  function groupMultipart(questions) {
    const multipartMap = new Map();
    const order = [];
    const seenBases = new Set();

    for (const q of questions) {
      const baseId = getBaseId(q.number);
      if (baseId !== null) {
        if (!seenBases.has(baseId)) {
          seenBases.add(baseId);
          multipartMap.set(baseId, []);
          order.push({ type: "multi", baseId });
        }
        multipartMap.get(baseId).push(q);
      } else {
        order.push({ type: "single", question: q });
      }
    }

    const result = [];
    for (const entry of order) {
      if (entry.type === "single") {
        result.push(entry.question);
      } else {
        const { baseId } = entry;
        const parts = multipartMap.get(baseId).sort((a, b) =>
          a.number < b.number ? -1 : a.number > b.number ? 1 : 0
        );
        const totalMark = parts.reduce((s, p) => s + (p.maxMark || 0), 0) || null;
        result.push({
          number: baseId,
          maxMark: totalMark,
          questionText: null,
          choices: [],
          answer: "",
          markscheme: null,
          parts: parts.map((p) => ({
            id: p.number,
            part: getPartLabel(p.number, baseId),
            questionText: p.questionText,
            markscheme: p.markscheme,
            maxMark: p.maxMark,
          })),
        });
      }
    }
    return result;
  }

  // ── API / data loading ─────────────────────────────────────────────────────

  const SECTION_FILES = {
    structure1:  "/data/structure1.json",
    structure2:  "/data/structure2.json",
    structure3:  "/data/structure3.json",
    reactivity1: "/data/reactivity1.json",
    reactivity2: "/data/reactivity2.json",
    reactivity3: "/data/reactivity3.json",
  };

  /**
   * Fetch questions from the Worker API.
   * Falls back to loading JSON files directly if the API fails.
   */
  async function fetchQuestions(sections) {
    // Try the Worker API first
    try {
      const url = `/api/questions?sections=${sections.join(",")}`;
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (_) {
      // Ignore; fall through to direct file fetch
    }

    // Fallback: load and parse JSON files directly
    const seen = new Set();
    const parsed = [];

    await Promise.all(
      sections.map(async (section) => {
        const path = SECTION_FILES[section];
        if (!path) return;
        try {
          const res = await fetch(path);
          if (!res.ok) return;
          const data = await res.json();
          for (const item of data) {
            if (seen.has(item.number)) continue;
            seen.add(item.number);
            parsed.push(parseQuestion(item));
          }
        } catch (_) {
          // Skip missing files
        }
      })
    );

    return groupMultipart(parsed);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function animateCard(direction, callback) {
    questionCard.classList.add("leaving");
    setTimeout(() => {
      questionCard.classList.remove("leaving");
      questionCard.classList.add("entering");
      callback();
      // Force reflow before removing entering class
      questionCard.getBoundingClientRect();
      questionCard.classList.remove("entering");
    }, 120);
  }

  function renderQuestion(q) {
    questionCode.textContent = q.number || "—";
    maxMarkEl.textContent = q.maxMark ? `[${q.maxMark}]` : "";

    // Clear question text area
    questionText.textContent = "";

    if (q.parts && q.parts.length > 0) {
      // Multipart question – render each part
      choicesList.hidden = true;
      choicesList.innerHTML = "";

      q.parts.forEach((part) => {
        const partDiv = document.createElement("div");
        partDiv.className = "part-item";

        const labelSpan = document.createElement("span");
        labelSpan.className = "part-label";
        labelSpan.textContent = `(${part.part})`;

        const textSpan = document.createElement("span");
        textSpan.textContent = part.questionText || "";

        partDiv.appendChild(labelSpan);
        partDiv.appendChild(textSpan);
        questionText.appendChild(partDiv);
      });
    } else {
      // Regular MCQ question
      questionText.textContent = q.questionText || "";

      choicesList.innerHTML = "";
      if (q.choices && q.choices.length > 0) {
        choicesList.hidden = false;
        q.choices.forEach((choice) => {
          const li = document.createElement("li");
          li.className = "choice-item";

          // Extract label (A, B, C, D) and text
          const match = choice.match(/^([A-D])\.\s*([\s\S]*)/);
          const label = match ? match[1] : "";
          const text  = match ? match[2].trim() : choice;

          const labelSpan = document.createElement("span");
          labelSpan.className = "choice-label";
          labelSpan.textContent = label;

          const textSpan = document.createElement("span");
          textSpan.textContent = text;

          li.appendChild(labelSpan);
          li.appendChild(textSpan);
          choicesList.appendChild(li);
        });
      } else {
        choicesList.hidden = true;
      }
    }

    // Hide markscheme
    hideMarkscheme();

    // Clear any incorrect-answer marks from previous interaction
    choicesList.querySelectorAll(".choice-item").forEach((item) => {
      item.classList.remove("incorrect");
    });

    // Update counter
    questionCounter.textContent = `${currentIndex + 1} / ${questions.length}`;
  }

  function showMarkscheme(q) {
    markschemeVisible = true;

    if (q.parts && q.parts.length > 0) {
      // Multipart: show each part's markscheme
      answerDisplay.textContent = "";
      markschemeText.textContent = "";

      q.parts.forEach((part) => {
        const partDiv = document.createElement("div");
        partDiv.className = "markscheme-part";

        const labelSpan = document.createElement("span");
        labelSpan.className = "part-label";
        labelSpan.textContent = `(${part.part})${part.maxMark ? ` [${part.maxMark}]` : ""}`;

        const msText = document.createElement("p");
        msText.textContent = part.markscheme || "";

        partDiv.appendChild(labelSpan);
        partDiv.appendChild(msText);
        markschemeText.appendChild(partDiv);
      });
    } else {
      answerDisplay.textContent = q.answer
        ? `Answer: ${q.answer}`
        : "Answer: —";

      markschemeText.textContent = q.markscheme || "";

      // Highlight correct choice
      const items = choicesList.querySelectorAll(".choice-item");
      items.forEach((item) => {
        const label = item.querySelector(".choice-label");
        if (label && label.textContent === q.answer) {
          item.classList.add("correct");
        }
      });
    }

    markschemeSection.hidden = false;
  }

  function hideMarkscheme() {
    markschemeVisible = false;
    markschemeSection.hidden = true;
    answerDisplay.textContent = "";
    markschemeText.textContent = "";

    // Remove highlight and incorrect marks
    choicesList.querySelectorAll(".choice-item").forEach((item) => {
      item.classList.remove("correct", "incorrect");
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  function currentQuestion() {
    if (!queue.length) return null;
    return questions[queue[currentIndex]];
  }

  function goNext() {
    if (!questions.length) return;
    currentIndex = (currentIndex + 1) % queue.length;
    animateCard("forward", () => renderQuestion(currentQuestion()));
  }

  function goPrev() {
    if (!questions.length) return;
    currentIndex = (currentIndex - 1 + queue.length) % queue.length;
    animateCard("back", () => renderQuestion(currentQuestion()));
  }

  function toggleMarkscheme() {
    const q = currentQuestion();
    if (!q) return;
    if (markschemeVisible) {
      hideMarkscheme();
    } else {
      showMarkscheme(q);
    }
  }

  // ── Start practice ─────────────────────────────────────────────────────────

  async function startPractice() {
    const selected = checkboxes
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);

    if (!selected.length) {
      selectionError.hidden = false;
      return;
    }
    selectionError.hidden = true;

    showOverlay(loadingOverlay);

    try {
      const data = await fetchQuestions(selected);

      if (!data || data.length === 0) {
        hideOverlay(loadingOverlay);
        showOverlay(emptyOverlay);
        return;
      }

      questions = data;
      queue = shuffle(Array.from({ length: questions.length }, (_, i) => i));
      currentIndex = 0;

      hideOverlay(loadingOverlay);
      showScreen(practiceScreen);
      renderQuestion(currentQuestion());
    } catch (err) {
      hideOverlay(loadingOverlay);
      console.error("Failed to load questions:", err);
      showOverlay(emptyOverlay);
    }
  }

  function returnToSplash() {
    questions = [];
    queue = [];
    currentIndex = 0;
    accuracyDisplay.textContent = "—";
    questionCounter.textContent = "0 / 0";
    hideMarkscheme();
    showScreen(splashScreen);
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  // Enable/disable Start button based on checkbox state
  checkboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      const anyChecked = checkboxes.some((c) => c.checked);
      startBtn.disabled = !anyChecked;
      if (anyChecked) selectionError.hidden = true;
    });
  });

  startBtn.addEventListener("click", startPractice);
  backBtn.addEventListener("click", returnToSplash);
  nextBtn.addEventListener("click", goNext);
  emptyBackBtn.addEventListener("click", () => {
    hideOverlay(emptyOverlay);
    returnToSplash();
  });

  // Keyboard navigation
  document.addEventListener("keydown", (e) => {
    // Only handle keys when the practice screen is active
    if (!practiceScreen.classList.contains("active")) return;

    // Prevent scroll on arrow keys
    if (["ArrowLeft", "ArrowRight", " "].includes(e.key)) {
      e.preventDefault();
    }

    switch (e.key) {
      case "Enter":
      case " ":
        toggleMarkscheme();
        break;
      case "ArrowRight":
        goNext();
        break;
      case "ArrowLeft":
        goPrev();
        break;
      case "a":
      case "A":
        selectAnswer("A");
        break;
      case "b":
      case "B":
        selectAnswer("B");
        break;
      case "c":
      case "C":
        selectAnswer("C");
        break;
      case "d":
      case "D":
        selectAnswer("D");
        break;
    }
  });

  /**
   * Highlight the chosen answer and reveal markscheme.
   * @param {string} letter - "A" | "B" | "C" | "D"
   */
  function selectAnswer(letter) {
    const q = currentQuestion();
    if (!q) return;

    // Reveal the markscheme (show correct answer)
    showMarkscheme(q);

    // Mark the chosen letter as incorrect if it doesn't match the answer
    if (letter !== q.answer) {
      const items = choicesList.querySelectorAll(".choice-item");
      items.forEach((item) => {
        const label = item.querySelector(".choice-label");
        if (label && label.textContent === letter) {
          item.classList.add("incorrect");
        }
      });
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  // Ensure splash is shown on load
  showScreen(splashScreen);
})();
