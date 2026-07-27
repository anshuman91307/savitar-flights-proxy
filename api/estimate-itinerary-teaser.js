// api/estimate-itinerary-teaser.js (clean version — replace the debug one with this)
// ─────────────────────────────────────────────────────────
const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 52000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const teaserCache = new Map();
const CACHE_MAX_ENTRIES = 300;

function cacheKeyFor({ destination, star, nights, travelMonth }){
  return [String(destination || '').toLowerCase().trim(), 'star' + star, 'nights' + nights, 'month' + (travelMonth || '')].join('|');
}

function parseItineraryText(text){
  const blocks = String(text || '').split(/\n\s*\n/).map(function(b){ return b.trim(); }).filter(Boolean);
  const days = [];
  blocks.forEach(function(block){
    const lines = block.split('\n').map(function(l){ return l.trim(); });
    const entry = { dayRange: null, region: null, vibe: null, highlight: null };
    lines.forEach(function(line){
      const m1 = /^day:\s*(.+)/i.exec(line);
      if (m1) { entry.dayRange = m1[1].trim(); return; }
      const m2 = /^region:\s*(.+)/i.exec(line);
      if (m2) { entry.region = m2[1].trim(); return; }
      const m3 = /^vibe:\s*(.+)/i.exec(line);
      if (m3) { entry.vibe = m3[1].trim(); return; }
      const m4 = /^highlight:\s*(.+)/i.exec(line);
      if (m4) { entry.highlight = m4[1].trim(); return; }
    });
    if (entry.dayRange && entry.region) days.push(entry);
  });
  return days;
}

async function getItineraryTeaser({ destination, star, nights, pax, travelMonth }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return [];

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;

  const systemPrompt = 'You draft short trip-teaser outlines for a luxury travel agency (Savitar Tours). Split the '
    + 'trip into 2-4 logical regions/stops based on the destination and length. For EACH stop, respond in exactly '
    + 'this plain text block format, with a blank line between blocks, no markdown, no other commentary:\n'
    + 'Day: <day range, e.g. "1-3">\n'
    + 'Region: <city/region name>\n'
    + 'Vibe: <one short evocative phrase>\n'
    + 'Highlight: <one specific type of experience — do not invent exact hotel names, prices, or bookable tour '
    + 'names you don\'t actually know exist>';

  const userPrompt = `Destination: ${destination}\n`
    + `Hotel category: ${star}-star\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + `Travelers: ${pax}\n`
    + (monthName ? `Travel month: ${monthName}\n` : '');

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
    if (!resp.ok) return [];
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return [];
    return parseItineraryText(text);
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
    const { destination, star, nights, pax, travelMonth } = source;
    const tripArgs = {
      destination, star: star || '4', nights: parseInt(nights, 10) || 1, pax: parseInt(pax, 10) || 1,
      travelMonth: travelMonth ? parseInt(travelMonth, 10) : null
    };

    const key = cacheKeyFor(tripArgs);
    if (teaserCache.has(key)) {
      res.status(200).json({ days: teaserCache.get(key), cached: true });
      return;
    }

    const days = await getItineraryTeaser(tripArgs);

    if (days.length) {
      if (teaserCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = teaserCache.keys().next().value;
        teaserCache.delete(oldestKey);
      }
      teaserCache.set(key, days);
    }

    res.status(200).json({ days: days, cached: false });
  } catch (e) {
    res.status(200).json({ days: [], cached: false });
  }
};
