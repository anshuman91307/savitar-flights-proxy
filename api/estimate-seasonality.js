// api/estimate-seasonality.js — DEBUG VERSION (temporary, to see Kimi's raw response)
// ─────────────────────────────────────────────────────────
const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 27000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const seasonCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheKeyFor({ destination, travelYear, travelMonth }){
  return [String(destination || '').toLowerCase().trim(), 'year' + (travelYear || ''), 'month' + (travelMonth || '')].join('|');
}

function parseSeasonalityText(text){
  const lines = String(text || '').split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  const result = { score: null, bestFor: null, caveat: null, alternativeMonth: null };
  lines.forEach(function(line){
    const m1 = /^score:\s*(\d+)/i.exec(line);
    if (m1) { result.score = parseInt(m1[1], 10); return; }
    const m2 = /^best for:\s*(.+)/i.exec(line);
    if (m2) { result.bestFor = m2[1].trim(); return; }
    const m3 = /^caveat:\s*(.+)/i.exec(line);
    if (m3) { result.caveat = m3[1].trim(); return; }
    const m4 = /^consider instead:\s*(.+)/i.exec(line);
    if (m4) { result.alternativeMonth = m4[1].trim(); return; }
  });
  return result;
}

async function getSeasonality({ destination, travelYear, travelMonth }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'the requested travel time';

  const systemPrompt = 'You rate travel timing for a luxury travel agency (Savitar Tours). Respond in EXACTLY this '
    + 'plain text format, nothing else, no markdown, no extra commentary:\n'
    + 'Score: <number>/10\n'
    + 'Best for: <short phrase>\n'
    + 'Caveat: <short phrase>\n'
    + 'Consider instead: <a different month name, or "None" if this month is already ideal>';

  const userPrompt = `Rate travel to ${destination} in ${whenText} for a luxury trip.`;

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
        max_tokens: 600
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      return { score: null, bestFor: null, caveat: null, alternativeMonth: null, debugError: 'HTTP ' + resp.status + ': ' + errBody.slice(0,300) };
    }
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return { score: null, bestFor: null, caveat: null, alternativeMonth: null, debugError: 'Kimi returned no text at all. Full response: ' + JSON.stringify(data).slice(0,300) };
    var parsed = parseSeasonalityText(text);
    parsed.debugRawText = text; // TEMPORARY: shows exactly what Kimi said, to check it matches the expected format
    return parsed;
  } catch (e) {
    return { score: null, bestFor: null, caveat: null, alternativeMonth: null, debugError: 'Exception: ' + e.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports.config = { maxDuration: 30 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'GET or POST only' }); return; }

  try {
    const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const { destination, travelYear, travelMonth } = source;
    const tripArgs = {
      destination, travelYear: parseInt(travelYear, 10), travelMonth: travelMonth ? parseInt(travelMonth, 10) : null
    };

    const key = cacheKeyFor(tripArgs);
    if (seasonCache.has(key)) {
      res.status(200).json(Object.assign({ cached: true }, seasonCache.get(key)));
      return;
    }

    const parsed = await getSeasonality(tripArgs);
    const result = parsed || { score: null, bestFor: null, caveat: null, alternativeMonth: null };

    if (parsed && parsed.score !== null) {
      if (seasonCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = seasonCache.keys().next().value;
        seasonCache.delete(oldestKey);
      }
      seasonCache.set(key, result);
    }

    res.status(200).json(Object.assign({ cached: false }, result));
  } catch (e) {
    res.status(200).json({ score: null, bestFor: null, caveat: null, alternativeMonth: null, cached: false });
  }
};
