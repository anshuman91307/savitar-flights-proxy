// api/estimate-nodata.js
// ─────────────────────────────────────────────────────────
// Called ONLY when /api/estimate returns { noData: true } — i.e. no
// website rate or invoice history exists for this destination/star/date
// combination yet. Instead of a dead-end "sorry, no data" message, this
// generates something encouraging plus a pre-written note the traveler
// can send straight to an advisor.
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-nodata
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 27000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const nodataCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheKeyFor({ destination, star, nights, pax, travelYear, travelMonth }){
  return [
    String(destination || '').toLowerCase().trim(),
    'star' + star, 'nights' + nights, 'pax' + pax, 'year' + (travelYear || ''), 'month' + (travelMonth || '')
  ].join('|');
}

async function getNoDataMessage({ destination, star, nights, pax, travelYear, travelMonth }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'their preferred travel window';

  const systemPrompt = 'You write short, warm messages for a luxury travel agency (Savitar Tours) when a destination '
    + 'doesn\'t have automated pricing yet. Write 2-3 sentences that sound genuinely excited about the destination '
    + '(not apologetic about missing data), then end with a natural note that an advisor will personally build them '
    + 'a bespoke quote. Do not invent specific hotel names, prices, or itinerary details. Plain, warm prose — no '
    + 'markdown headers, a couple of short paragraphs is fine.';

  const userPrompt = `A traveler is interested in: ${destination}\n`
    + `Hotel category: ${star}-star\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + `Travelers: ${pax}\n`
    + `Approximate travel time: ${whenText}\n`
    + `We don't have automated pricing data for this destination/date combination yet.`;

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
        max_tokens: 1000
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

module.exports.config = { maxDuration: 30 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'GET or POST only' }); return; }

  try {
    const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const { destination, star, nights, pax, travelYear, travelMonth } = source;
    const tripArgs = {
      destination, star: star || '4', nights: parseInt(nights, 10) || 1, pax: parseInt(pax, 10) || 1,
      travelYear: parseInt(travelYear, 10), travelMonth: travelMonth ? parseInt(travelMonth, 10) : null
    };

    const key = cacheKeyFor(tripArgs);
    if (nodataCache.has(key)) {
      res.status(200).json({ message: nodataCache.get(key), cached: true });
      return;
    }

    const message = await getNoDataMessage(tripArgs);

    if (message) {
      if (nodataCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = nodataCache.keys().next().value;
        nodataCache.delete(oldestKey);
      }
      nodataCache.set(key, message);
    }

    res.status(200).json({ message: message, cached: false });
  } catch (e) {
    res.status(200).json({ message: null });
  }
};
