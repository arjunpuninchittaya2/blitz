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
 * @returns {object}    - { number, questionText, choices, answer, markscheme }
 */
function parseQuestion(raw) {
  const scraped = raw.scraped || "";

  // Split on A. / B. / C. / D. to isolate question text + choice blocks
  const choiceRegex = /(?=\bA\.|\bB\.|\bC\.|\bD\.)/;
  const parts = scraped.split(choiceRegex);

  // First segment is the question text (everything before the first choice)
  const questionText = (parts[0] || raw.question || "").trim();

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

  return {
    number: raw.number || "",
    questionText: questionText.replace(/\n+/g, " ").trim(),
    choices,
    answer,
    markscheme,
  };
}

/**
 * Load, parse, and deduplicate questions for the given section keys.
 * @param {string[]} sections - e.g. ["structure1", "reactivity2"]
 * @returns {object[]}
 */
function loadQuestions(sections) {
  const seen = new Set();
  const results = [];

  for (const section of sections) {
    const raw = DATA_MAP[section];
    if (!raw) continue;
    for (const item of raw) {
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      results.push(parseQuestion(item));
    }
  }

  return results;
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
