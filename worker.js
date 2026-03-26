/**
 * Blitz Study App - Cloudflare Worker
 * Serves static frontend assets and provides the /api/questions endpoint.
 */

// ── Inline data imports (bundled at deploy time via wrangler) ───────────────
import structure1Data from "./data/structure1.json";
import structure2Data from "./data/structure2.json";
import structure3Data from "./data/structure3.json";
import reactivity1Data from "./data/reactivity1.json";
import reactivity2Data from "./data/reactivity2.json";
import reactivity3Data from "./data/reactivity3.json";

const DATA_MAP = {
  structure1: structure1Data,
  structure2: structure2Data,
  structure3: structure3Data,
  reactivity1: reactivity1Data,
  reactivity2: reactivity2Data,
  reactivity3: reactivity3Data,
};

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a raw "scraped" string into a structured question object.
 * @param {object} raw  - { number, question, url, scraped }
 * @returns {object}    - { number, questionText, choices, answer, markscheme, maxMark }
 */
function parseQuestion(raw) {
  const scraped = raw.scraped || "";

  // Extract max mark from "[Maximum mark: X]" (may use non-breaking spaces)
  const maxMarkMatch = scraped.match(/\[Maximum[\s\u00a0]mark:[\s\u00a0]*(\d+)\]/i);
  const maxMark = maxMarkMatch ? parseInt(maxMarkMatch[1], 10) : null;

  // Split on A. / B. / C. / D. to isolate question text + choice blocks
  const choiceRegex = /(?=\bA\.|\bB\.|\bC\.|\bD\.)/;
  const parts = scraped.split(choiceRegex);

  // First segment is the question text (everything before the first choice)
  let questionText = (parts[0] || raw.question || "").trim();

  // Strip markscheme section (bleeds into parts[0] for non-MCQ questions)
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

  // Extract individual choices (A–D)
  const choices = [];
  const choiceLabelRegex = /^([A-D])\.\s*/;
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i].trim();
    // Stop at "Markscheme" section
    if (/^Markscheme/i.test(segment)) break;
    // Strip any trailing "Markscheme" block that bled in
    const cleanSegment = segment.replace(/\n?Markscheme[\s\S]*/i, "").trim();
    if (choiceLabelRegex.test(cleanSegment)) {
      choices.push(cleanSegment);
    }
  }

  // Extract answer letter from "Markscheme\nX" pattern
  const answerMatch = scraped.match(/Markscheme\s*\n\s*([A-D])\b/i);
  const answer = answerMatch ? answerMatch[1].toUpperCase() : "";

  // Extract markscheme explanation (everything after the answer letter line)
  let markscheme = "";
  const msMatch = scraped.match(
    /Markscheme\s*\n\s*[A-D]\s*\n([\s\S]*)/i
  );
  if (msMatch) {
    markscheme = msMatch[1].trim();
  } else {
    // Fallback: everything after "Markscheme"
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

// ── Multipart grouping ───────────────────────────────────────────────────────

/**
 * Get the base question ID for a multipart question.
 * Returns null for standalone (non-multipart) questions.
 * e.g. "21N.2.SL.TZ0.5a"    → "21N.2.SL.TZ0.5"
 *      "22M.2.SL.TZ2.8a(ii)" → "22M.2.SL.TZ2.8"
 *      "22N.2.SL.TZ0.4a.ii"  → "22N.2.SL.TZ0.4"
 *      "22M.2.SL.TZ2.a(ii)"  → "22M.2.SL.TZ2"
 *      "23M.1A.SL.TZ1.1"     → null (standalone MCQ)
 */
function getBaseId(number) {
  const segs = number.split(".");
  const last = segs[segs.length - 1];

  // Roman numeral sub-part: last segment is "i", "ii", "iii", "iv", "v", etc.
  if (/^x{0,3}(?:ix|iv|v?i{0,3})$/i.test(last) && last !== "") {
    const prefix = segs.slice(0, -1);
    const prevLast = prefix[prefix.length - 1];
    const baseOfPrev = (prevLast.match(/^(\d*)/) || ["", ""])[1];
    if (baseOfPrev) {
      return prefix.slice(0, -1).concat(baseOfPrev).join(".");
    }
    return prefix.slice(0, -1).join(".");
  }

  // Last segment contains a letter: "5a", "5a(ii)", "a", "a(ii)", "4d"
  if (/[a-z]/i.test(last)) {
    const baseOfLast = (last.match(/^(\d*)/) || ["", ""])[1];
    if (baseOfLast) {
      return segs.slice(0, -1).concat(baseOfLast).join(".");
    }
    return segs.slice(0, -1).join(".");
  }

  return null; // Standalone question
}

/**
 * Extract the part label from a full question ID given its base ID.
 * e.g. "21N.2.SL.TZ0.5a",   base "21N.2.SL.TZ0.5" → "a"
 *      "22M.2.SL.TZ2.8a(ii)", base "22M.2.SL.TZ2.8" → "a(ii)"
 *      "22N.2.SL.TZ0.4a.ii",  base "22N.2.SL.TZ0.4" → "a(ii)"
 */
function getPartLabel(number, baseId) {
  let part = number.slice(baseId.length);
  if (part.startsWith(".")) part = part.slice(1);
  // Normalise "a.ii" → "a(ii)": trailing .roman segment
  part = part.replace(/\.(x{0,3}(?:ix|iv|v?i{0,3}))$/i, "($1)");
  return part || number;
}

/**
 * Group multipart questions (sharing the same base ID) into a single object.
 * Standalone MCQ questions pass through unchanged.
 */
function groupMultipart(questions) {
  const multipartMap = new Map(); // baseId → [question, ...]
  const order = []; // first-occurrence insertion order
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

/**
 * Load, parse, deduplicate, and group questions for the given section keys.
 * @param {string[]} sections - e.g. ["structure1", "reactivity2"]
 * @returns {object[]}
 */
function loadQuestions(sections) {
  const seen = new Set();
  const parsed = [];

  for (const section of sections) {
    const raw = DATA_MAP[section];
    if (!raw) continue;
    for (const item of raw) {
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      parsed.push(parseQuestion(item));
    }
  }

  return groupMultipart(parsed);
}

// ── CORS helper ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ── Request handler ──────────────────────────────────────────────────────────
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── API: GET /api/questions?sections=structure1,reactivity2 ──────────────
  if (url.pathname === "/api/questions") {
    const sectionsParam = url.searchParams.get("sections") || "";
    const sections = sectionsParam
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (sections.length === 0) {
      return new Response(
        JSON.stringify({ error: "No sections specified." }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        }
      );
    }

    const unknown = sections.filter((s) => !DATA_MAP[s]);
    if (unknown.length === sections.length) {
      return new Response(
        JSON.stringify({ error: `Unknown sections: ${unknown.join(", ")}` }),
        {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        }
      );
    }

    const questions = loadQuestions(sections);
    return new Response(JSON.stringify(questions), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ...corsHeaders(),
      },
    });
  }

  // ── Static assets via Assets binding ────────────────────────────────────
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
