// api/estimate.js
// ─────────────────────────────────────────────────────────
// Deploy alongside your existing savitar-flights-proxy project on
// Vercel. Reachable at:
//   https://savitar-flights-proxy.vercel.app/api/estimate
//
// PRICING MODEL — three-tier fallback, in priority order:
//
//   1. WEBSITE RATE (best): exact destination + star-category match
//      from website-rates.json (Savitar Tools → Website Rates).
//      Falls back to averaging across whatever star categories ARE
//      entered for that destination if the exact star isn't there.
//
//   2. INVOICE HISTORY (fallback while website rates are still being
//      filled in): if there's no website rate at all for a destination,
//      fall back to real historical per-day rates from
//      savitar-rate-history.json (Savitar Tools → Invoices →
//      "Generate Rate History (JSON)"). That file uses a small set of
//      destination "buckets" from earlier in the project — mapped to
//      full country names below (some buckets combine two countries,
//      e.g. Portugal & Spain, China & Korea — noted where approximate).
//
//   3. NO DATA YET: if neither source has anything for that
//      destination, we do NOT show a fabricated number — the widget
//      shows a "we don't have this yet, please contact us" message
//      instead. Better to be honest than to show a guessed price for
//      somewhere Savitar has never actually operated.
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
// countries — that's carried over from the earlier curated destination
// list and is an approximation for the invoice-history fallback only;
// it does not affect website rates, which are keyed by exact country.
const COUNTRY_TO_HISTORY_BUCKET = {
  'iceland': 'iceland',
  'croatia': 'croatia',
  'morocco': 'morocco',
  'greece': 'greece',
  'ecuador': 'galapagos', // Galápagos is part of Ecuador
  'egypt': 'egypt',
  'south africa': 'southafrica',
  'portugal': 'portugal', // bucket originally combined Portugal & Spain
  'spain': 'portugal',
  'china': 'asia',        // bucket originally combined China & Korea
  'south korea': 'asia',
  'north korea': 'asia',
};

function normalize(s){ return String(s || '').toLowerCase().trim(); }

function fromWebsiteRates(destination, star){
  const dest = normalize(destination);
  const matchesDest = WEBSITE_RATES.filter(function(r){ return normalize(r.destination) === dest; });
  if (!matchesDest.length) return null;

  const exact = matchesDest.filter(function(r){ return String(r.star) === String(star); });
  const pool = exact.length ? exact : matchesDest;
  const avg = pool.reduce(function(sum, r){ return sum + parseFloat(r.rate); }, 0) / pool.length;
  return { rate: avg, exactStarMatch: exact.length > 0, source: 'website' };
}

function fromInvoiceHistory(destination, targetYear){
  const bucket = COUNTRY_TO_HISTORY_BUCKET[normalize(destination)];
  if (!bucket) return null;
  const matches = RATE_HISTORY.filter(function(p){ return p.destination === bucket; });
  if (!matches.length) return null;

  // Same year-escalation idea as before: 10%/year gap, compounding,
  // only escalating forward (never discount for a later historical year).
  const year = targetYear || (new Date().getFullYear() + 1);
  const escalated = matches.map(function(p){
    const gap = year - p.travelYear;
    return gap > 0 ? p.perPersonPerDay * Math.pow(1.10, gap) : p.perPersonPerDay;
  });
  const avg = escalated.reduce(function(a,b){ return a+b; }, 0) / escalated.length;
  return { rate: avg, exactStarMatch: false, source: 'invoiceHistory' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    const { destination, star, nights, pax, travelYear } = req.body || {};
    const numNights = Math.max(1, parseInt(nights, 10) || 1);
    const numPax = Math.max(1, parseInt(pax, 10) || 1);
    const starCategory = star || '4';

    let found = fromWebsiteRates(destination, starCategory);
    if (!found) found = fromInvoiceHistory(destination, parseInt(travelYear, 10));

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
      source: found.source // 'website' or 'invoiceHistory' — widget can use this to word the caveat
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed' });
  }
};
