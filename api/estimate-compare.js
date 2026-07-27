// api/estimate-compare.js
// ─────────────────────────────────────────────────────────
// "Compare" toggle for when a customer is deciding between two
// destinations. Same plain-text-labeled-lines approach as the other new
// endpoints — "Pro A" / "Pro B" refer positionally to whichever two
// destinations were sent, avoiding any need to match on the destination
// name text itself while parsing.
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-compare
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 52000;

const compareCache = new Map();
const CACHE_MAX_ENTRIES = 300;

function cacheKeyFor({ destinationA, destinationB, star, nights, travelMonth }){
  const pair = [String(destinationA||'').toLowerCase().trim(), String(destinationB||'').toLowerCase().trim()].sort().join('+');
  return [pair, 'star' + star, 'nights' + nights, 'month' + (travelMonth || '')].join('|');
}

function parseCompareText(text){
  const lines = String(text || '').split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  const result = { winner: null, prosA: [], prosB: [], priceNote: null, recommendation: null };
  lines.forEach(function(line){
    const mWin = /^winner:\s*(.+)/i.exec(line);
    if (mWin) { result.winner = mWin[1].trim(); return; }
    const mA = /^pro a:\s*(.+)/i.exec(line);
    if (mA) { result.prosA.push(mA[1].trim()); return; }
    const mB = /^pro b:\s*(.+)/i.exec(line);
    if (mB) { result.prosB.push(mB[1].trim()); return; }
    const mPrice = /^price note:\s*(.+)/i.exec(line);
    if (mPrice) { result.priceNote = mPrice[1].trim(); return; }
    const mRec = /^recommendation:\s*(.+)/i.exec(line);
    if (mRec) { result.recommendation = mRec[1].trim(); return; }
  });
  return result;
}

async function getComparison({ destinationA, destinationB, star, nights, pax, travelMonth }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = 'You compare travel destinations for a luxury travel agency (Savitar Tours). Respond in '
    + 'EXACTLY this plain text format, nothing else, no markdown:\n'
    + 'Winner: <name of the destination you\'d lean toward for this specific trip, or "Both" if genuinely a toss-up>\n'
    + 'Pro A: <one short reason for the FIRST destination>\n'
    + 'Pro A: <another reason for the first destination>\n'
    + 'Pro A: <another reason for the first destination>\n'
    + 'Pro B: <one short reason for the SECOND destination>\n'
    + 'Pro B: <another reason for the second destination>\n'
    + 'Pro B: <another reason for the second destination>\n'
    + 'Price note: <one short sentence on how their price levels typically compare>\n'
    + 'Recommendation: <one sentence, who each destination suits best>\n'
    + 'Do not invent specific hotel names, exact prices, or bookable tour names you don\'t actually know exist.';

  const userPrompt = `First destination: ${destinationA}\n`
    + `Second destination: ${destinationB}\n`
    + `Trip type: ${nights} night${nights === 1 ? '' : 's'}, ${star}-star, ${pax} traveler${pax === 1 ? '' : 's'}`
    + (travelMonth ? `, traveling in month ${travelMonth}` : '');

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
    if (!text) return null;
    return parseCompareText(text);
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
    const { destinationA, destinationB, star, nights, pax, travelMonth } = source;
    const tripArgs = {
      destinationA, destinationB, star: star || '4', nights: parseInt(nights, 10) || 1,
      pax: parseInt(pax, 10) || 1, travelMonth: travelMonth ? parseInt(travelMonth, 10) : null
    };

    const key = cacheKeyFor(tripArgs);
    if (compareCache.has(key)) {
      res.status(200).json(Object.assign({ cached: true }, compareCache.get(key)));
      return;
    }

    const parsed = await getComparison(tripArgs);
    const result = parsed || { winner: null, prosA: [], prosB: [], priceNote: null, recommendation: null };

    if (parsed && parsed.winner) {
      if (compareCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = compareCache.keys().next().value;
        compareCache.delete(oldestKey);
      }
      compareCache.set(key, result);
    }

    res.status(200).json(Object.assign({ cached: false }, result));
  } catch (e) {
    res.status(200).json({ winner: null, prosA: [], prosB: [], priceNote: null, recommendation: null, cached: false });
  }
};
