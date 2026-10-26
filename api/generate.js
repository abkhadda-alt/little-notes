// Serverless function (Vercel) — turns quick staff notes into a parent-friendly daily report.
// The Gemini API key stays on the server and is never exposed to the browser.

// Main model first, then backups if it's overloaded.
const MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
].filter((m, i, all) => all.indexOf(m) === i);
const MAX_NOTES = 2000;

const LANGS = { en: "English", fr: "Canadian French (Québec)" };
const TONES = {
  warm: "warm, cheerful and reassuring",
  brief: "friendly but short and to the point",
  professional: "polite and professional",
};

function buildPrompt({ childName, notes, mood, language, tone }) {
  return `You are an assistant for early-childhood educators at a daycare.
Turn the educator's quick notes into a daily report for the child's parents.

Rules:
- Write in ${LANGS[language] || LANGS.en}.
- Tone: ${TONES[tone] || TONES.warm}.
- Only include facts that are in the notes. Never invent meals, times, activities or incidents.
- If something important is missing (e.g. no nap mentioned), simply leave it out.
- If the notes mention an incident, injury or concern, report it calmly and clearly, without minimizing it.
- Use short sections with one emoji each, only for the sections that have info:
  🍽️ Meals, 😴 Rest, 🎨 Activities, 😊 Mood, 🩹 Notes for parents.
- Start with a one-line greeting and end with a one-line warm sign-off from "Your child's educators".
- 60 to 150 words. Plain text only, no markdown symbols like ** or #.

Child's first name: ${childName || "the child"}
Overall mood selected by the educator: ${mood || "not specified"}
Educator's notes:
"""
${notes}
"""`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const notes = String(body.notes || "").trim();
  const childName = String(body.childName || "").trim().slice(0, 40);

  if (!notes) return res.status(400).json({ error: "Please add some notes first." });
  if (notes.length > MAX_NOTES) {
    return res.status(400).json({ error: `Notes are too long (max ${MAX_NOTES} characters).` });
  }

  const prompt = buildPrompt({
    childName,
    notes,
    mood: String(body.mood || "").slice(0, 30),
    language: body.language,
    tone: body.tone,
  });

  const callGemini = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Generous budget: newer models spend part of it "thinking" before writing.
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
      }),
    });

  try {
    // If a model is overloaded (503), hiccups (500) or isn't available (404),
    // fall back to the next one so parents still get their report.
    let r, data;
    for (const model of MODELS) {
      r = await callGemini(model);
      data = await r.json().catch(() => ({}));
      if (r.ok || ![404, 500, 503].includes(r.status)) break;
    }

    if (!r.ok) {
      if (r.status === 429) {
        return res.status(429).json({ error: "Too many requests right now — try again in a minute." });
      }
      if (r.status === 503) {
        return res.status(503).json({ error: "The AI is very busy right now. Please try again in a moment." });
      }
      return res.status(502).json({ error: data?.error?.message || "AI service error" });
    }

    const report = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();

    if (!report) return res.status(502).json({ error: "The AI returned an empty report. Try again." });
    return res.status(200).json({ report });
  } catch (err) {
    return res.status(500).json({ error: "Could not reach the AI service." });
  }
}

export { buildPrompt };
