// api/estimate-packing-list.js
// ─────────────────────────────────────────────────────────
// Bonus content for the confirmation email after a quote/lead is
// submitted — a packing list grouped by category. Same plain-text-block
// parsing approach as the itinerary teaser (blocks separated by blank
// lines, labeled fields within each block).
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-packing-list
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 52000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const packingCache = new Map();
const CACHE_MAX_ENTRIES = 300;

function cacheKeyFor({ destination, nights, travelMonth, tripNotes }){
  return [
    String(destination||'').toLowerCase().trim(), 'nights' + nights, 'month' + (travelMonth||''),
    String(tripNotes||'').toLowerCase().trim()
  ].join('|');
}

function parsePackingText(text){
  const blocks = String(text || '').split(/\n\s*\n/).map(function(b){ return b.trim(); }).filter(Boolean);
  const categories = [];
  blocks.forEach(function(block){
    const lines = block.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
    let name = null;
    const items = [];
    lines.forEach(function(line){
      const mCat = /^category:\s*(.+)/i.exec(line);
      if (mCat) { name = mCat[1].trim(); return; }
      const mItem = /^item:\s*(.+)/i.exec(line);
      if (mItem) { items.push(mItem[1].trim()); return; }
    });
    if (name && items.length) categories.push({ name, items });
  });
  return categories;
}

async function getPackingList({ destination, nights, travelMonth, tripNotes }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return [];

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;

  const systemPrompt = 'You write packing lists for a luxury travel agency (Savitar Tours). Group items into 3-5 '
    + 'categories (e.g. Clothing, Gear, Documents, Toiletries — adjust to fit the actual trip). Respond in EXACTLY '
    + 'this plain text block format, blank line between categories, no markdown, no other commentary:\n'
    + 'Category: <name>\n'
    + 'Item: <specific item>\n'
    + 'Item: <specific item>\n'
    + '(3-6 items per category). Flag anything genuinely hard to find locally by adding "(pack from home)" after '
    + 'that item specifically.';

  const userPrompt = `Destination: ${destination}\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + (monthName ? `Travel month: ${monthName}\n` : '')
    + (tripNotes ? `Additional notes: ${tripNotes}\n` : '')
    + 'This is a luxury trip.';

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
        max_tokens: 1800
      }),
      signal: controller.signal
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return [];
    return parsePackingText(text);
  } catch (e) {
    return [];
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
    const { destination, nights, travelMonth, tripNotes } = source;
    const tripArgs = {
      destination, nights: parseInt(nights, 10) || 1, travelMonth: travelMonth ? parseInt(travelMonth, 10) : null, tripNotes
    };

    const key = cacheKeyFor(tripArgs);
    if (packingCache.has(key)) {
      res.status(200).json({ categories: packingCache.get(key), cached: true });
      return;
    }

    const categories = await getPackingList(tripArgs);

    if (categories.length) {
      if (packingCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = packingCache.keys().next().value;
        packingCache.delete(oldestKey);
      }
      packingCache.set(key, categories);
    }

    res.status(200).json({ categories: categories, cached: false });
  } catch (e) {
    res.status(200).json({ categories: [], cached: false });
  }
};
