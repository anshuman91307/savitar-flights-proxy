// api/estimate.js
// ─────────────────────────────────────────────────────────
// Deploy alongside your existing savitar-flights-proxy project on
// Vercel. Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate
//
// PRICING MODEL — three-tier fallback, in priority order:
//
//   1. WEBSITE RATE (best): matches destination + star category, and
//      PREFERS an exact season/month match (e.g. a December-specific
//      rate) over an "All Year" rate for the same destination+star,
//      since peak-season pricing can differ a lot from off-peak.
//      Falls back to averaging across whatever star categories ARE
//      entered for that destination if the exact star isn't there.
//
//   2. INVOICE HISTORY (fallback while website rates are still being
//      filled in): real historical per-day rates from
//      savitar-rate-history.json, escalated 10%/year (compounding) for
//      older data. Also prefers historical invoices from the SAME
//      travel month when there are enough of them, otherwise blends
//      across all months for that destination.
//
//   3. NO DATA YET: if neither source has anything, the widget shows a
//      "we don't have this yet, please contact us" message instead of
//      a fabricated number.
//
// Both website-rates.json and savitar-rate-history.json need to be
// copied into this same /api folder for the requires below to work.
// Either or both can be missing/empty — the code handles that.
// ─────────────────────────────────────────────────────────

const CUSTOM_TOUR_MARKUP = 1.15; // 15% — flat for launch

let WEBSITE_RATES = [];
try { WEBSITE_RATES = require('./website-rates.json'); } catch (e) { WEBSITE_RATES = []; }

let RATE_HISTORY = [];
try { RATE_HISTORY = require('./savitar-rate-history.json'); } catch (e) { RATE_HISTORY = []; }

// Maps full country names (what the widget sends) to the older bucket
// keys used by the invoice-history generator. Some buckets combine two
// countries — carried over from an earlier curated destination list,
// an approximation for the invoice-history fallback only.
const COUNTRY_TO_HISTORY_BUCKET = {
  'iceland': 'iceland', 'croatia': 'croatia', 'morocco': 'morocco', 'greece': 'greece',
  'ecuador': 'galapagos', 'egypt': 'egypt', 'south africa': 'southafrica',
  'portugal': 'portugal', 'spain': 'portugal', 'china': 'asia',
  'south korea': 'asia', 'north korea': 'asia', 'kenya': 'kenya', 'japan': 'japan',
};

function normalize(s){ return String(s || '').toLowerCase().trim(); }

function fromWebsiteRates(destination, star, month){
  const dest = normalize(destination);
  const matchesDest = WEBSITE_RATES.filter(function(r){ return normalize(r.destination) === dest; });
  if (!matchesDest.length) return null;

  // Prefer the requested star category; fall back to any star for this destination
  const starMatches = matchesDest.filter(function(r){ return String(r.star) === String(star); });
  const starPool = starMatches.length ? starMatches : matchesDest;

  // Within that, prefer an exact month/season match over "All Year" entries
  const monthExact = starPool.filter(function(r){ return String(r.month || '') === String(month || ''); });
  const allYear = starPool.filter(function(r){ return !r.month; });
  const pool = monthExact.length ? monthExact : (allYear.length ? allYear : starPool);

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

  // Prefer historical invoices from the same travel month, if there are
  // any; otherwise blend across whatever months exist for this destination.
  const monthMatches = targetMonth
    ? matches.filter(function(p){ return p.travelMonth && parseInt(p.travelMonth,10) === parseInt(targetMonth,10); })
    : [];
  const pool = monthMatches.length ? monthMatches : matches;

  const escalated = pool.map(function(p){
    const gap = year - p.travelYear;
    return gap > 0 ? p.perPersonPerDay * Math.pow(1.10, gap) : p.perPersonPerDay;
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

    let found = fromWebsiteRates(destination, starCategory, month);
    if (!found) found = fromInvoiceHistory(destination, parseInt(travelYear, 10), month);

    if (!found) {
      res.status(200).json({ noData: true });
      return;
    }

    const markedUpRate = found.rate * CUSTOM_TOUR_MARKUP;
    const total = markedUpRate * numNights * numPax;

    res.status(200).json({
      total: Math.round(total),
      perPersonPerNight: Math.round(markedUpRate * 100) / 100,
      matched: true,
      exactStarMatch: found.exactStarMatch,
      exactMonthMatch: found.exactMonthMatch,
      source: found.source
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed' });
  }
};
