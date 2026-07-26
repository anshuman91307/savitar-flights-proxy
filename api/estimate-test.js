const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_TIMEOUT_MS = 8000;  // ← under Vercel's 10s free limit

// ... keep all your existing functions ...

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

    let aiSummary = null;
    try {
      aiSummary = await getKimiSummary({
        destination, star: starCategory, nights: numNights, pax: numPax,
        travelYear: parseInt(travelYear, 10), travelMonth: month,
        perPersonTotal, groupTotal
      });
    } catch (e) {
      aiSummary = { debugError: 'Kimi failed: ' + e.message };
    }
    aiSummary = aiSummary || { debugError: 'KIMI_API_KEY not set' };

    res.status(200).json({
      perPersonTotal,
      total: groupTotal,
      perPersonPerNight: Math.round(finalRate * 100) / 100,
      matched: true,
      exactStarMatch: found.exactStarMatch,
      exactMonthMatch: found.exactMonthMatch,
      source: found.source,
      aiSummary
    });
  } catch (e) {
    res.status(500).json({ error: 'estimate failed', detail: e.message });
  }
};

handler.config = { maxDuration: 30 };
module.exports = handler;
