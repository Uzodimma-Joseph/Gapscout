// Provider layer: SerpAPI (Google Maps + Google) and Nominatim geocoding.
// All network access is injectable (deps.fetchFn / deps.sleep) so it can be tested with fixtures.
const SERP_URL = 'https://serpapi.com/search.json';
const EMPTY = /hasn'?t returned any results/i; // SerpApi's "no results" message is not a failure
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

async function serpGet(params, { fetchFn = fetch, key = process.env.SERPAPI_KEY, retries = 2, sleep = sleepDefault } = {}) {
  if (!key) return { ok: false, error: 'SERPAPI_KEY is not set' };
  const url = SERP_URL + '?' + new URLSearchParams({ ...params, api_key: key });
  let last = 'unknown error';
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => null);
      if (json && json.error) return EMPTY.test(json.error) ? { ok: true, json: {} } : { ok: false, error: String(json.error) };
      if (!res.ok || !json) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, json };
    } catch (e) {
      last = String(e.message || e).split(key).join('***'); // never leak the key into logs
      if (i < retries) await sleep(500 * 2 ** i);
    }
  }
  return { ok: false, error: last };
}

// Free geocoder. Policy: identify yourself via User-Agent, max ~1 request/second.
async function geocode(s, { fetchFn = fetch, userAgent = process.env.NOMINATIM_UA || 'GapScout/0.1 (set NOMINATIM_UA with your contact email)' } = {}) {
  const q = [s.area, s.city, s.region, s.country].filter(Boolean).join(', ');
  try {
    const res = await fetchFn('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '5' }),
      { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `geocoder HTTP ${res.status}` };
    const rows = await res.json();
    if (!rows.length) return { ok: false, error: `Location not found: "${q}". Please check the spelling or add a state/region.` };
    const states = new Set(rows.map((r) => r.address && r.address.state).filter(Boolean));
    if (!s.region && states.size > 1) return { ok: false, ambiguous: true, error: `Location "${q}" is ambiguous (matches ${[...states].join(', ')}). Please specify the state/region.` };
    return { ok: true, lat: +rows[0].lat, lng: +rows[0].lon, display: rows[0].display_name };
  } catch (e) { return { ok: false, error: `geocoder: ${e.message}` }; }
}

const mapsParams = (s, { ll, start = 0 }) => ({
  engine: 'google_maps', type: 'search', hl: 'en', start,
  q: `${s.category} in ${[s.area, s.city, s.region, s.country].filter(Boolean).join(', ')}`,
  ...(ll ? { ll } : {}),
});

// Maps sometimes returns place_results (single place) instead of local_results.
function normalizeMaps(json) {
  const list = json.local_results || (json.place_results ? [json.place_results] : []);
  return list.filter((r) => r && r.title).map((r) => {
    const pid = r.place_id || r.data_id || r.data_cid || null;
    return {
      name: r.title, source: 'serpapi_maps', source_id: pid && String(pid),
      category: r.type || (Array.isArray(r.types) && r.types[0]) || null,
      phone: r.phone || null, address: r.address || null, description: r.description || null,
      lat: r.gps_coordinates ? r.gps_coordinates.latitude : null, lng: r.gps_coordinates ? r.gps_coordinates.longitude : null,
      listing_website: r.website || null, // a hint only; verified separately
      image_url: r.thumbnail || null, image_source: r.thumbnail ? 'Google Maps listing (via SerpApi); reuse rights not verified' : null,
      listing_url: r.place_id ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}` : null,
      raw: { position: r.position, rating: r.rating, reviews: r.reviews },
    };
  });
}

// Query count drives cost: 1 SerpApi credit per query. Phone/address checks only run when that data exists.
function verificationQueries(b, deep = false) {
  const ng = /nigeria/i.test(b.country || '');
  const geo = ng ? { google_domain: 'google.com.ng', gl: 'ng' } : { google_domain: 'google.com' };
  const loc = [b.city, b.region].filter(Boolean).join(' ');
  const national = b.phone && b.phone.startsWith('+234') ? '0' + b.phone.slice(4) : b.phone;
  const out = [{ type: 'name_location', q: `"${b.name}" ${loc}` }];
  if (b.phone) out.push({ type: 'name_phone', q: `"${b.name}" "${national}"` });
  if (b.address) out.push({ type: 'name_address', q: `"${b.name}" ${b.address}` });
  if (deep && b.category) out.push({ type: 'name_category', q: `${b.name} ${b.category} ${b.city || ''}`.trim() });
  return out.map((x) => ({ type: x.type, params: { engine: 'google', q: x.q, hl: 'en', num: 10, ...geo } }));
}

const normalizeOrganic = (json) => (json.organic_results || []).filter((r) => r.link).map((r) => ({ url: r.link, title: r.title || '', snippet: r.snippet || '' }));

module.exports = { serpGet, geocode, mapsParams, normalizeMaps, verificationQueries, normalizeOrganic };
