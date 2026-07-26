// api/estimate.js
// ─────────────────────────────────────────────────────────
// Deploy alongside your existing savitar-flights-proxy project on
// Vercel. Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate
//
// PRICING MODEL — three-tier fallback, in priority order:
//
//   1. WEBSITE RATE: a published GROUP-tour rate, so it gets a markup
//      to estimate a bespoke/private trip — AND that markup itself
//      climbs each year out from today, since website rates are
//      always "current" published prices with no built-in inflation:
//        2026 (baseline) → +15%
//        2027            → +20%
//        2028            → +25%
//        ...+5% per year beyond the baseline
//      Prefers an exact season/month match over an "All Year" rate,
//      and the requested star category (falling back to any star).
//
//   2. INVOICE HISTORY: real prices actually charged for CUSTOM/private
//      trips — this is already private-trip pricing, so it gets NO
//      extra markup at all. If the historical invoice's travel year
//      matches (or is later than) the requested travel year, used
//      as-is. If the invoice is from an EARLIER year, escalated 5%
//      per year of gap via dividing by 0.95 (compounding).
//      Prefers same-travel-month historical invoices when available.
//
//   3. NO DATA YET: if neither source has anything, the widget shows a
//      "we don't have this yet, please contact us" message instead of
//      a fabricated number.
//
// Both website-rates.json and savitar-rate-history.json need to be
// copied into this same /api folder for the requires below to work.
// Either or both can be missing/empty — the code handles that.
//
// AI SUMMARY (Kimi / Moonshot) — added on top of the existing math:
//   Once the real perPersonTotal/groupTotal figures are calculated
//   (unchanged from before), we separately ask Kimi to write a short,
//   warm, evocative Markdown summary to accompany those numbers on the
//   widget. This is pure presentation flavor — it never replaces or
//   hides the actual calculated price, which is still returned as-is
//   in the same JSON response. If the Kimi call fails or times out for
//   any reason, the estimate still returns normally with just the
//   numbers, so a third-party AI hiccup can never break a live quote.
// ─────────────────────────────────────────────────────────

const WEBSITE_MARKUP_BASE_YEAR = 2026; // bump this forward each year
const WEBSITE_MARKUP_BASE = 1.15;      // +15% in the base year
const WEBSITE_MARKUP_PER_YEAR = 0.05;  // +5 percentage points per year beyond the base year
const YEARLY_ESCALATION = 0.95;        // invoice-history escalation: rate ÷ 0.95 per year of gap (≈ +5.26%/yr)

const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_MODEL = 'moonshot-v1-8k';
const KIMI_TIMEOUT_MS = 8000; // don't let a slow AI call hold up the whole estimate

function websiteMarkupForYear(targetYear){
  const year = targetYear || (new Date().getFullYear() + 1);
  const yearsOut = Math.max(0, year - WEBSITE_MARKUP_BASE_YEAR);
  return WEBSITE_MARKUP_BASE + WEBSITE_MARKUP_PER_YEAR * yearsOut;
}

let WEBSITE_RATES = [];
try { WEBSITE_RATES = require('./website-rates.json'); } catch (e) { WEBSITE_RATES = []; }

let RATE_HISTORY = [];
try { RATE_HISTORY = require('./savitar-rate-history.json'); } catch (e) { RATE_HISTORY = []; }

// Maps full country names (what the widget sends) to the bucket keys
// used by the invoice-history dataset.
const COUNTRY_TO_HISTORY_BUCKET = {
  'iceland': 'iceland', 'croatia': 'croatia', 'morocco': 'morocco', 'greece': 'greece',
  'ecuador': 'ecuador', 'egypt': 'egypt', 'south africa': 'southafrica',
  'portugal': 'portugal', 'spain': 'portugal', 'china': 'china',
  'south korea': 'china', 'north korea': 'china', // no dedicated Korea data yet — nearest available
  'kenya': 'kenya', 'japan': 'japan',
  'armenia': 'armenia', 'australia': 'australia', 'austria': 'austria', 'brazil': 'brazil',
  'cambodia': 'cambodia', 'india': 'india', 'indonesia': 'indonesia', 'ireland': 'ireland',
  'italy': 'italy', 'maldives': 'maldives', 'mexico': 'mexico', 'nepal': 'nepal',
  'peru': 'peru', 'tanzania': 'tanzania', 'thailand': 'thailand', 'tunisia': 'tunisia',
  'turkey': 'turkey', 'french polynesia': 'frenchpolynesia',
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function normalize(s){ return String(s || '').toLowerCase().trim(); }

function fromWebsiteRates(destination, star, month, occupancy){
  const dest = normalize(destination);
  const matchesDest = WEBSITE_RATES.filter(function(r){ return normalize(r.destination) === dest; });
  if (!matchesDest.length) return null;

  const starMatches = matchesDest.filter(function(r){ return String(r.star) === String(star); });
  const starPool = starMatches.length ? starMatches : matchesDest;

  // Prefer the requested occupancy (double/single); fall back to whichever exists
  const occMatches = starPool.filter(function(r){ return String(r.occupancy || 'double') === String(occupancy); });
  const occPool = occMatches.length ? occMatches : starPool;

  const monthExact = occPool.filter(function(r){ return String(r.month || '') === String(month || ''); });
  const allYear = occPool.filter(function(r){ return !r.month; });
  const pool = monthExact.length ? monthExact : (allYear.length ? allYear : occPool);

  const avg = pool.reduce(function(sum, r){ return sum + parseFloat(r.rate); }, 0) / pool.length;
  return {
    rate: avg, // markup now applied uniformly at the top level, regardless of source
    exactStarMatch: starMatches.length > 0,
    exactMonthMatch: monthExact.length > 0,
    source: 'website'
  };
}

function fromInvoiceHistory(destination, targetYear, targetMonth){
  const bucket = COUNTRY_TO_HISTORY_BUCKET[normalize(destination)];
  if (!bucket) return null;
  const matches = RATE_HISTORY.filter(function(p){ return p.destination === bucket; });
  if (!matches.length) return null;

  const year = targetYear || (new Date().getFullYear() + 1);

  const monthMatches = targetMonth
    ? matches.filter(function(p){ return p.travelMonth && parseInt(p.travelMonth,10) === parseInt(targetMonth,10); })
    : [];
  const pool = monthMatches.length ? monthMatches : matches;

  const escalated = pool.map(function(p){
    const gap = year - p.travelYear;
    // Same year or later historical data → use the real sell price as-is.
    // Older data → +5%/year via dividing by 0.95, compounding.
    return gap > 0 ? p.perPersonPerDay / Math.pow(YEARLY_ESCALATION, gap) : p.perPersonPerDay;
  });
  const avg = escalated.reduce(function(a,b){ return a+b; }, 0) / escalated.length;
  return {
    rate: avg, // NO markup — this is already a real sell price
    exactStarMatch: false,
    exactMonthMatch: monthMatches.length > 0,
    source: 'invoiceHistory'
  };
}

// ── Kimi / Moonshot AI summary ──────────────────────────────────────
// Fires only after the real math is done. Failure here is always
// non-fatal to the estimate response — see the try/catch at the call site.
async function getKimiSummary({ destination, star, nights, pax, travelYear, travelMonth, perPersonTotal, groupTotal }){
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return null; // no key configured — skip silently, numbers still work fine

  const monthName = travelMonth ? MONTH_NAMES[parseInt(travelMonth, 10) - 1] : null;
  const whenText = [monthName, travelYear].filter(Boolean).join(' ') || 'their preferred travel window';

  const systemPrompt = 'You are the pricing voice for a luxury travel agency (Savitar Tours). Read the traveller\'s '
    + 'preferences and the price already calculated for them, then write a short, warm, beautifully formatted '
    + 'summary in Markdown (2-4 sentences, plus the price clearly stated). Make it feel personal and evocative, '
    + 'not like a generic quote. Do not invent or name specific hotels, flights, or itinerary details you were not '
    + 'given — you don\'t have access to real inventory, so stick to the destination, trip length, and the price. '
    + 'Close with a warm, natural invitation to speak with an advisor to tailor the exact details — not a hard '
    + 'sales push, just a genuine "let\'s make this yours" note.';

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
        temperature: 0.7
      }),
      signal: controller.signal
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return text || null;
  } catch (e) {
    return null; // timeout, network error, bad response shape — all non-fatal
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const { destination, star, nights, pax, travelYear, travelMonth } = req.body || {};
    const numNights = Math.max(1, parseInt(nights, 10) || 1);
    const numPax = Math.max(1, parseInt(pax, 10) || 1);
    const starCategory = star || '4';
    const month = travelMonth ? parseInt(travelMonth, 10) : null;
    const occupancy = numPax <= 1 ? 'single' : 'double';

    let found = fromWebsiteRates(destination, starCategory, month, occupancy);
    if (!found) found = fromInvoiceHistory(destination, parseInt(travelYear, 10), month);

    if (!found) {
      res.status(200).json({ noData: true });
      return;
    }

    // Website rates get the year-based markup; invoice history gets none —
    // it's already real private-trip pricing, only escalated for data age.
    const finalRate = found.source === 'website'
      ? found.rate * websiteMarkupForYear(parseInt(travelYear, 10))
      : found.rate;

    const perPersonTotal = Math.round(finalRate * numNights);
    const groupTotal = Math.round(perPersonTotal * numPax);

    // AI summary is purely additive — any failure here falls back to null
    // and the widget just shows the numbers without the flavor text.
    let aiSummary = null;
    try {
      aiSummary = await getKimiSummary({
        destination, star: starCategory, nights: numNights, pax: numPax,
        travelYear: parseInt(travelYear, 10), travelMonth: month,
        perPersonTotal, groupTotal
      });
    } catch (e) {
      aiSummary = null;
    }

    res.status(200).json({
      perPersonTotal: perPersonTotal,
      total: groupTotal,
      perPersonPerNight: Math.round(finalRate * 100) / 100,
      matched: true,
      exactStarMatch: found.exactStarMatch,
      exactMonthMatch: found.exactMonthMatch,
      source: found.source,
      aiSummary: aiSummary
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed' });
  }
};
