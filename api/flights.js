export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { from, to, dep, ret, pax } = req.query;
  const url = `https://serpapi.com/search?engine=google_flights&departure_id=${from}&arrival_id=${to}&outbound_date=${dep}${ret?'&return_date='+ret:''}&adults=${pax||1}&currency=USD&hl=en&api_key=550326df30cb79478c6beef4d5879422b0eb68551ee0ccb01a078c207fa28289`;
  const r = await fetch(url);
  const data = await r.json();
  res.json(data);
}
