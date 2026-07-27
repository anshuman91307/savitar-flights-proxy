// api/estimate-summary.js — DEBUG VERSION (temporary, to find the real cause)
// ─────────────────────────────────────────────────────────
const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 27000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const summaryCache = new Map();
const CACHE_MAX_ENTRIES = 500;

function cacheKeyFor({ destination, star, nights, travelYear, travelMonth }){
  return [
    String(destination || '').toLowerCase().trim(),
    'star' + star, 'nights' + nights, 'year' + (travelYear || ''), 'month' + (travelMonth || '')
  ].join('|');
}

async function getKimiSummary({ destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return { debugError: 'KIMI_API_KEY not set in this environment' };

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'their preferred travel window';

  const systemPrompt = 'You are the pricing voice for a luxury travel agency (Savitar Tours). Read the traveller\'s '
    + 'preferences and the price already calculated for them, then write a short, warm, beautifully formatted '
    + 'summary in Markdown (2-4 sentences, plus the price clearly stated). Make it feel personal and evocative, '
    + 'not like a generic quote. Do not invent or name specific hotels, flights, or itinerary details you were not '
    + 'given — you don\'t have access to real inventory, so stick to the destination, trip length, and the price. '
    + 'End on the trip\'s appeal itself — do NOT add your own closing pitch or invitation to contact an advisor; '
    + 'there is a separate real button for that right below your text, so your own sign-off would just be redundant.';

  const userPrompt = `Destination: ${destination}\n`
    + `Hotel category: ${star}-star\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + `Travelers: ${pax}\n`
    + `Approximate travel time: ${whenText}\n`
    + `Calculated per-person price: $${perPersonTotal}\n`
    + `Calculated group total: $${groupTotal}`;

  const controller = new AbortController();
  const timeout = setTimeout(function(){ controller.abort(); }, KIMI_TIMEOUT_MS);

  try {
    const resp = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 1,
        max_tokens: 1500
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      return { debugError: 'HTTP ' + resp.status + ': ' + errBody.slice(0, 300) };
    }
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return text || { debugError: 'Kimi responded OK but unexpected shape: ' + JSON.stringify(data).slice(0,300) };
  } catch (e) {
    return { debugError: 'Exception: ' + e.message };
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
    const { destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal } = source;
    const tripArgs = {
      destination, star: star || '4', nights: parseInt(nights, 10) || 1, pax: parseInt(pax, 10) || 1,
      travelYear: parseInt(travelYear, 10), travelMonth: travelMonth ? parseInt(travelMonth, 10) : null,
      perPersonTotal, groupTotal
    };

    const key = cacheKeyFor(tripArgs);
    if (summaryCache.has(key)) {
      res.status(200).json({ aiSummary: summaryCache.get(key), cached: true });
      return;
    }

    const aiSummary = await getKimiSummary(tripArgs);

    if (typeof aiSummary === 'string') {
      if (summaryCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = summaryCache.keys().next().value;
        summaryCache.delete(oldestKey);
      }
      summaryCache.set(key, aiSummary);
    }

    res.status(200).json({ aiSummary: aiSummary, cached: false });
  } catch (e) {
    res.status(200).json({ aiSummary: { debugError: 'Outer exception: ' + e.message } });
  }
};
