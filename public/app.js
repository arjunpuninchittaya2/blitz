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
    const choiceRegex = /(?=\bA\.|\bB\.|\bC\.|\bD\.)/;
    const parts = scraped.split(choiceRegex);

    const questionTextParsed = (parts[0] || raw.question || "").trim();

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

    return {
      number: raw.number || "",
      questionText: questionTextParsed.replace(/\n+/g, " ").trim(),
      choices,
      answer,
      markscheme,
    };
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
    const results = [];

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
            results.push(parseQuestion(item));
          }
        } catch (_) {
          // Skip missing files
        }
      })
    );

    return results;
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
    questionText.textContent = q.questionText || "";

    // Choices
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

    answerDisplay.textContent = q.answer
      ? `Answer: ${q.answer}`
      : "Answer: —";

    markschemeText.textContent = q.markscheme || "";
    markschemeSection.hidden = false;

    // Highlight correct choice
    const items = choicesList.querySelectorAll(".choice-item");
    items.forEach((item) => {
      const label = item.querySelector(".choice-label");
      if (label && label.textContent === q.answer) {
        item.classList.add("correct");
      }
    });
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
