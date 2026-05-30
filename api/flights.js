export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { from, to, dep, ret, pax, cls } = req.query;

  if (!from || !to || !dep) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: from,
    arrival_id: to,
    outbound_date: dep,
    adults: pax || '1',
    cabin_class: cls || '1',
    currency: 'USD',
    hl: 'en',
    api_key: process.env.SERPAPI_KEY
  });

  if (ret) params.append('return_date', ret);

  try {
    const r = await fetch(`https://serpapi.com/search?${params}`);
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Fetch failed', detail: e.message });
  }
}
