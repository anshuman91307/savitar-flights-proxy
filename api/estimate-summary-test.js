// api/estimate-summary.js
// Calls Kimi only when needed. Caches successful responses in memory.
// Cache survives warm requests; resets on cold start (standard for serverless).

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 8000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── Simple in-memory cache ─────────────────────────────────────────
const CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60;        // 1 hour
const CACHE_MAX_ENTRIES = 500;              // prevent unbounded growth

function cacheKey(body) {
  // Normalise only the fields that affect the summary text
  const { destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal } = body || {};
  return JSON.stringify({
    d: String(destination || '').toLowerCase().trim(),
    s: String(star || '4'),
    n: String(nights || ''),
    p: String(pax || ''),
    y: String(travelYear || ''),
    m: String(travelMonth || ''),
    ppt: String(perPersonTotal || ''),
    gt: String(groupTotal || '')
  });
}

function getCached(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  // Evict oldest if at limit (simple FIFO)
  if (CACHE.size >= CACHE_MAX_ENTRIES) {
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
  CACHE.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}
// ─────────────────────────────────────────────────────────────────

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    res.status(200).json({ aiSummary: null, debugError: 'KIMI_API_KEY not set' });
    return;
  }

  const body = req.body || {};
  const key = cacheKey(body);

  // 1. Return cached summary instantly (~1ms)
  const cached = getCached(key);
  if (cached) {
    res.status(200).json({ aiSummary: cached, cached: true });
    return;
  }

  const { destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal } = body;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'their preferred travel window';

  const systemPrompt = 'You are the pricing voice for a luxury travel agency (Savitar Tours). Read the traveller\'s '
    + 'preferences and the price already calculated for them, then write a short, warm, beautifully formatted '
    + 'summary in Markdown (2-4 sentences, plus the price clearly stated). Make it feel personal and evocative, '
    + 'not like a generic quote. Do not invent or name specific hotels, flights, or itinerary details you were not '
    + 'given — you don\'t have access to real inventory, so stick to the destination, trip length, and the price. '
    + 'Close with a warm, natural invitation to speak with an advisor to tailor the exact details — not a hard '
    + 'sales push, just a genuine "let\'s make this yours" note.';

  const userPrompt = `Destination: ${destination || 'Unknown'}\n`
    + `Hotel category: ${star || '4'}-star\n`
    + `Trip length: ${nights || '?'} night${parseInt(nights) === 1 ? '' : 's'}\n`
    + `Travelers: ${pax || '?'}\n`
    + `Approximate travel time: ${whenText}\n`
    + `Calculated per-person price: $${perPersonTotal || '?'}\n`
    + `Calculated group total: $${groupTotal || '?'}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KIMI_TIMEOUT_MS);

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
        temperature: 1
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      res.status(200).json({ aiSummary: null, debugError: 'HTTP ' + resp.status + ': ' + errBody.slice(0, 300) });
      return;
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      res.status(200).json({ aiSummary: null, debugError: 'Empty response from Kimi' });
      return;
    }

    // 2. Store in cache for next time
    setCached(key, text);

    res.status(200).json({ aiSummary: text, cached: false });
  } catch (e) {
    res.status(200).json({ aiSummary: null, debugError: 'Exception: ' + e.message });
  } finally {
    clearTimeout(timeout);
  }
};

handler.config = { maxDuration: 10 };
module.exports = handler;
