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
// NOTE ON THE AI SUMMARY: this endpoint intentionally does NOT call
// Kimi/Moonshot at all anymore — that logic lives in the separate
// api/estimate-summary.js endpoint instead, so the widget can show this
// price INSTANTLY and fetch the AI blurb afterward in the background.
// Kimi's response time is inconsistent (a few seconds to 20+ seconds),
// and a customer should never have to wait on that just to see a price.
// ─────────────────────────────────────────────────────────

const WEBSITE_MARKUP_BASE_YEAR = 2026;
const WEBSITE_MARKUP_BASE = 1.15;
const WEBSITE_MARKUP_PER_YEAR = 0.05;
const YEARLY_ESCALATION = 0.95;

function websiteMarkupForYear(targetYear){
  const year = targetYear || (new Date().getFullYear() + 1);
  const yearsOut = Math.max(0, year - WEBSITE_MARKUP_BASE_YEAR);
  return WEBSITE_MARKUP_BASE + WEBSITE_MARKUP_PER_YEAR * yearsOut;
}

let WEBSITE_RATES = [];
try { WEBSITE_RATES = require('./website-rates.json'); } catch (e) { WEBSITE_RATES = []; }

let RATE_HISTORY = [];
try { RATE_HISTORY = require('./savitar-rate-history.json'); } catch (e) { RATE_HISTORY = []; }

const COUNTRY_TO_HISTORY_BUCKET = {
  'iceland': 'iceland', 'croatia': 'croatia', 'morocco': 'morocco', 'greece': 'greece',
  'ecuador': 'ecuador', 'egypt': 'egypt', 'south africa': 'southafrica',
  'portugal': 'portugal', 'spain': 'portugal', 'china': 'china',
  'south korea': 'china', 'north korea': 'china',
  'kenya': 'kenya', 'japan': 'japan',
  'armenia': 'armenia', 'australia': 'australia', 'austria': 'austria', 'brazil': 'brazil',
  'cambodia': 'cambodia', 'india': 'india', 'indonesia': 'indonesia', 'ireland': 'ireland',
  'italy': 'italy', 'maldives': 'maldives', 'mexico': 'mexico', 'nepal': 'nepal',
  'peru': 'peru', 'tanzania': 'tanzania', 'thailand': 'thailand', 'tunisia': 'tunisia',
  'turkey': 'turkey', 'french polynesia': 'frenchpolynesia',
};

function normalize(s){ return String(s || '').toLowerCase().trim(); }

function fromWebsiteRates(destination, star, month, occupancy){
  const dest = normalize(destination);
  const matchesDest = WEBSITE_RATES.filter(function(r){ return normalize(r.destination) === dest; });
  if (!matchesDest.length) return null;

  const starMatches = matchesDest.filter(function(r){ return String(r.star) === String(star); });
  const starPool = starMatches.length ? starMatches : matchesDest;

  const occMatches = starPool.filter(function(r){ return String(r.occupancy || 'double') === String(occupancy); });
  const occPool = occMatches.length ? occMatches : starPool;

  const monthExact = occPool.filter(function(r){ return String(r.month || '') === String(month || ''); });
  const allYear = occPool.filter(function(r){ return !r.month; });
  const pool = monthExact.length ? monthExact : (allYear.length ? allYear : occPool);

  const avg = pool.reduce(function(sum, r){ return sum + parseFloat(r.rate); }, 0) / pool.length;
  return {
    rate: avg,
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
    return gap > 0 ? p.perPersonPerDay / Math.pow(YEARLY_ESCALATION, gap) : p.perPersonPerDay;
  });
  const avg = escalated.reduce(function(a,b){ return a+b; }, 0) / escalated.length;
  return {
    rate: avg,
    exactStarMatch: false,
    exactMonthMatch: monthMatches.length > 0,
    source: 'invoiceHistory'
  };
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

    const finalRate = found.source === 'website'
      ? found.rate * websiteMarkupForYear(parseInt(travelYear, 10))
      : found.rate;

    const perPersonTotal = Math.round(finalRate * numNights);
    const groupTotal = Math.round(perPersonTotal * numPax);

    res.status(200).json({
      perPersonTotal: perPersonTotal,
      total: groupTotal,
      perPersonPerNight: Math.round(finalRate * 100) / 100,
      matched: true,
      exactStarMatch: found.exactStarMatch,
      exactMonthMatch: found.exactMonthMatch,
      source: found.source
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed' });
  }
};
