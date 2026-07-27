// api/estimate-advisor-brief.js
// ─────────────────────────────────────────────────────────
// Triggered when a customer submits their contact info (the "send me
// this estimate" / lead capture step) — writes a short narrative brief
// for whichever Savitar advisor picks up the lead. This is INTERNAL-facing
// (goes to your team/CRM, not shown to the customer), so no caching —
// every lead submission is a unique brief.
// Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate-advisor-brief
// ─────────────────────────────────────────────────────────

const KIMI_API_URL = 'https://api.moonshot.ai/v1/chat/completions';
const KIMI_MODEL = 'kimi-k2.6';
const KIMI_TIMEOUT_MS = 52000;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function getAdvisorBrief({ destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal, customerName, customerEmail }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null;

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'an unspecified travel window';

  const systemPrompt = 'You write internal lead briefs for Savitar Tours\' advisor team — NOT customer-facing. Write '
    + 'exactly 3 short paragraphs, plain prose, no markdown headers:\n'
    + 'Paragraph 1: what the client is looking for (destination, trip shape, who\'s traveling).\n'
    + 'Paragraph 2: the budget level this implies and any constraints worth noting.\n'
    + 'Paragraph 3: two specific, genuinely useful suggestions for the advisor to raise on the follow-up call to '
    + 'make a strong first impression — general angles (e.g. "ask about special occasions," "mention shoulder-season '
    + 'advantages"), not invented specific hotel names or exact prices you don\'t actually know.';

  const userPrompt = `Client: ${customerName || '(name not provided)'}\n`
    + `Email: ${customerEmail || '(not provided)'}\n`
    + `Destination: ${destination}\n`
    + `Hotel category: ${star}-star\n`
    + `Trip length: ${nights} night${nights === 1 ? '' : 's'}\n`
    + `Travelers: ${pax}\n`
    + `Travel time: ${whenText}\n`
    + `Quoted price: $${perPersonTotal} per person ($${groupTotal} total)`;

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
    const { destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal, customerName, customerEmail } = source;

    const brief = await getAdvisorBrief({
      destination, star: star || '4', nights: parseInt(nights, 10) || 1, pax: parseInt(pax, 10) || 1,
      travelYear: parseInt(travelYear, 10), travelMonth: travelMonth ? parseInt(travelMonth, 10) : null,
      perPersonTotal, groupTotal, customerName, customerEmail
    });

    res.status(200).json({ brief: brief });
  } catch (e) {
    res.status(200).json({ brief: null });
  }
};
