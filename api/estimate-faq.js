// api/estimate-faq.js
// ─────────────────────────────────────────────────────────
// Lets a customer ask any free-form travel question right on the quote
// page ("Do I need a visa?", "What's the weather like?", "Is it safe to
// drink the tap water?") instead of leaving to search Google or a general
// AI tool.
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-faq
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 52000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const faqCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheKeyFor(question, destination){
  return String(destination || 'general').toLowerCase().trim() + '|' + String(question || '').toLowerCase().trim();
}

async function getFaqAnswer({ question, destination, nights, travelMonth, travelYear }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ');

  const systemPrompt = 'You answer traveler questions for a luxury travel agency (Savitar Tours), in the friendly, '
    + 'knowledgeable voice of an experienced advisor. Answer in 2-4 short sentences, plain warm prose, no markdown '
    + 'headers. Stick to genuinely useful travel information (visas, weather, packing, safety, culture, currency, '
    + 'best practices) — if a question is completely unrelated to travel, gently steer back: acknowledge it briefly '
    + 'and redirect to how you can help with their trip instead, don\'t just refuse. Do not invent specific prices, '
    + 'hotel names, or bookable details you don\'t actually know. If genuinely unsure about something factual '
    + '(exact visa rules, entry requirements), say so plainly and suggest confirming with an advisor or the relevant '
    + 'embassy rather than guessing.';

  const contextLine = destination
    ? `Trip context: ${destination}${nights ? ', ' + nights + ' nights' : ''}${whenText ? ', traveling around ' + whenText : ''}.\n`
    : '';
  const userPrompt = contextLine + `Question: ${question}`;

  const controller = new AbortController();
  const timeout = setTimeout(function(){ controller.abort(); }, KIMI_TIMEOUT_MS);

  try {
    const resp = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 1,
        max_tokens: 1500
      }),
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return text || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports.config = { maxDuration: 55 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'GET or POST only' }); return; }

  try {
    const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const { question, destination, nights, travelMonth, travelYear } = source;

    if (!question || !String(question).trim()) {
      res.status(200).json({ answer: null, error: 'No question provided' });
      return;
    }

    const key = cacheKeyFor(question, destination);
    if (faqCache.has(key)) {
      res.status(200).json({ answer: faqCache.get(key), cached: true });
      return;
    }

    const answer = await getFaqAnswer({
      question, destination, nights: nights ? parseInt(nights, 10) : null,
      travelMonth: travelMonth ? parseInt(travelMonth, 10) : null, travelYear: travelYear ? parseInt(travelYear, 10) : null
    });

    if (answer) {
      if (faqCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = faqCache.keys().next().value;
        faqCache.delete(oldestKey);
      }
      faqCache.set(key, answer);
    }

    res.status(200).json({ answer: answer, cached: false });
  } catch (e) {
    res.status(200).json({ answer: null });
  }
};
