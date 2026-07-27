// api/estimate-price-reason.js
// ─────────────────────────────────────────────────────────
// "Why this price?" tooltip. Widget calls this AFTER showing the price
// from /api/estimate (same background-load pattern as the AI summary) —
// this is a separate, smaller call so the price is never held up by it.
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-price-reason
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 27000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const reasonCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheKeyFor({ destination, star, nights, travelYear, travelMonth }){
  return [
    String(destination || '').toLowerCase().trim(),
    'star' + star, 'nights' + nights, 'year' + (travelYear || ''), 'month' + (travelMonth || '')
  ].join('|');
}

async function getPriceReason({ destination, star, nights, travelYear, travelMonth, perPersonTotal }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'the requested travel window';

  const systemPrompt = 'You explain travel pricing for a luxury travel agency (Savitar Tours) in exactly ONE short, '
    + 'warm sentence, under 25 words. Mention what actually drives the price — season/high-season timing, the hotel '
    + 'tier, or what\'s typically included (private guiding, transfers) — pick whichever is most relevant. Do not '
    + 'invent specific hotel names or exact inclusions you were not given. Plain text only, no markdown, no quotes '
    + 'around the sentence, just the sentence itself.';

  const userPrompt = `Destination: ${destination}\n`
    + `Hotel category: ${star}-star\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + `Travel time: ${whenText}\n`
    + `Price: $${perPersonTotal} per person`;

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
        max_tokens: 500
      }),
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return text ? text.trim() : null;
  } catch (e) {
    return null;
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
    const { destination, star, nights, travelYear, travelMonth, perPersonTotal } = source;
    const tripArgs = {
      destination, star: star || '4', nights: parseInt(nights, 10) || 1,
      travelYear: parseInt(travelYear, 10), travelMonth: travelMonth ? parseInt(travelMonth, 10) : null,
      perPersonTotal
    };

    const key = cacheKeyFor(tripArgs);
    if (reasonCache.has(key)) {
      res.status(200).json({ reason: reasonCache.get(key), cached: true });
      return;
    }

    const reason = await getPriceReason(tripArgs);

    if (reason) {
      if (reasonCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = reasonCache.keys().next().value;
        reasonCache.delete(oldestKey);
      }
      reasonCache.set(key, reason);
    }

    res.status(200).json({ reason: reason, cached: false });
  } catch (e) {
    res.status(200).json({ reason: null });
  }
};
