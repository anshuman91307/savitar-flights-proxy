// api/estimate-test.js
// Returns pricing instantly. No Kimi call. No timeout risk.

const WEBSITE_MARKUP_BASE_YEAR = 2026;
const WEBSITE_MARKUP_BASE = 1.15;
const WEBSITE_MARKUP_PER_YEAR = 0.05;
const YEARLY_ESCALATION = 0.95;

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

function websiteMarkupForYear(targetYear){
  const year = targetYear || (new Date().getFullYear() + 1);
  const yearsOut = Math.max(0, year - WEBSITE_MARKUP_BASE_YEAR);
  return WEBSITE_MARKUP_BASE + WEBSITE_MARKUP_PER_YEAR * yearsOut;
}

function fromWebsiteRates(destination, star, month, occupancy){
  const dest = normalize(destination);
  const matchesDest = WEBSITE_RATES.filter(r => normalize(r.destination) === dest);
  if (!matchesDest.length) return null;

  const starMatches = matchesDest.filter(r => String(r.star) === String(star));
  const starPool = starMatches.length ? starMatches : matchesDest;

  const occMatches = starPool.filter(r => String(r.occupancy || 'double') === String(occupancy));
  const occPool = occMatches.length ? occMatches : starPool;

  const monthExact = occPool.filter(r => String(r.month || '') === String(month || ''));
  const allYear = occPool.filter(r => !r.month);
  const pool = monthExact.length ? monthExact : (allYear.length ? allYear : occPool);

  const avg = pool.reduce((sum, r) => sum + parseFloat(r.rate), 0) / pool.length;
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
  const matches = RATE_HISTORY.filter(p => p.destination === bucket);
  if (!matches.length) return null;

  const year = targetYear || (new Date().getFullYear() + 1);
  const monthMatches = targetMonth
    ? matches.filter(p => p.travelMonth && parseInt(p.travelMonth, 10) === parseInt(targetMonth, 10))
    : [];
  const pool = monthMatches.length ? monthMatches : matches;

  const escalated = pool.map(p => {
    const gap = year - p.travelYear;
    return gap > 0 ? p.perPersonPerDay / Math.pow(YEARLY_ESCALATION, gap) : p.perPersonPerDay;
  });
  const avg = escalated.reduce((a, b) => a + b, 0) / escalated.length;
  return {
    rate: avg,
    exactStarMatch: false,
    exactMonthMatch: monthMatches.length > 0,
    source: 'invoiceHistory'
  };
}

const handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') { res.status(405).json({ error: 'GET or POST only' }); return; }

  try {
    const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const { destination, star, nights, pax, travelYear, travelMonth } = source;
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
      perPersonTotal,
      total: groupTotal,
      perPersonPerNight: Math.round(finalRate * 100) / 100,
      matched: true,
      exactStarMatch: found.exactStarMatch,
      exactMonthMatch: found.exactMonthMatch,
      source: found.source,
      aiSummary: null // frontend will fetch this separately
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed', detail: e.message });
  }
};

handler.config = { maxDuration: 10 };
module.exports = handler;
