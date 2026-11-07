// FIXTURE tests. Responses are hand-built to match SerpApi's documented field names
// (local_results[].title/phone/website/gps_coordinates/thumbnail, organic_results[].link/title/snippet).
// They are NOT recordings of live API output. No live SerpApi/Nominatim/Activepieces call is made.
const assert = require('assert');
const A = require('./app');
const S = require('./serp');
const db = A.openDb();
const res = (status, body) => ({ status, ok: status < 400, json: async () => body });
const noSleep = async () => {};
const KEY = 'SECRETKEY123';
let n = 0; const t = (name, fn) => Promise.resolve(fn()).then(() => console.log('PASS', ++n, name));

const NOMINATIM = [{ lat: '5.4840', lon: '7.0351', display_name: 'Owerri, Imo, Nigeria', address: { state: 'Imo' } }];
const mapsPage = (names) => ({ local_results: names.map((nm, i) => ({ position: i + 1, title: nm, place_id: 'pid_' + nm.replace(/\W/g, ''), type: 'Real estate agency',
  phone: i === 0 ? '0803 111 2222' : undefined, address: `${i + 1} Douglas Rd, Owerri`, gps_coordinates: { latitude: 5.48 + i / 1e4, longitude: 7.03 }, thumbnail: 'https://img.example/t.jpg',
  website: i === 1 ? 'https://zenithrealty.com.ng' : undefined })) });
const mk = (limit = 40) => A.createSearch(db, { query: 'real estate agencies in Owerri, Imo State, Nigeria', limit }).id;

(async () => {
  await t('normalizeMaps handles local_results and place_results; keeps nulls', () => {
    const c = S.normalizeMaps(mapsPage(['A Realty', 'B Realty']));
    assert.equal(c.length, 2); assert.equal(c[1].phone, null); assert.equal(c[1].listing_website, 'https://zenithrealty.com.ng');
    assert.equal(S.normalizeMaps({ place_results: { title: 'Solo', data_id: 'x' } })[0].name, 'Solo');
    assert.deepEqual(S.normalizeMaps({}), []);
  });
  await t('verification queries: phone/address checks only when data exists; Nigeria uses .com.ng', () => {
    const q = S.verificationQueries({ name: 'X', city: 'Owerri', country: 'Nigeria', phone: '+2348031112222', address: '1 Rd' });
    assert.deepEqual(q.map((x) => x.type), ['name_location', 'name_phone', 'name_address']);
    assert.ok(q[1].params.q.includes('08031112222')); assert.equal(q[0].params.google_domain, 'google.com.ng');
    assert.equal(S.verificationQueries({ name: 'X', city: 'Owerri' }).length, 1);
  });

  const full = Array.from({ length: 20 }, (_, i) => 'Agency' + i);
  const s1 = mk(40);
  await t('discover page 0: geocode once, ingest 20, hasMore true; ll passed to SerpApi', async () => {
    const urls = [];
    const fetchFn = async (u) => { urls.push(u); return u.includes('nominatim') ? res(200, NOMINATIM) : res(200, mapsPage(full)); };
    const r = await A.discoverPage(db, s1, 0, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.created, 20); assert.equal(r.hasMore, true);
    assert.ok(urls[1].includes('ll=%405.484') && urls[1].includes('engine=google_maps') && urls[1].includes('start=0'));
    assert.equal(A.getSearch(db, s1).status, 'discovering');
  });
  await t('discover page 1: short page => done; page 2 skipped with ZERO API calls', async () => {
    let calls = 0; const fetchFn = async () => { calls++; return res(200, mapsPage(['Last One'])); };
    const r = await A.discoverPage(db, s1, 1, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.hasMore, false);
    const before = calls; const r2 = await A.discoverPage(db, s1, 2, { fetchFn, key: KEY, sleep: noSleep });
    assert.ok(r2.skipped); assert.equal(calls, before); assert.equal(A.getSearch(db, s1).discovered, 21);
  });
  await t('repeat identical search creates no new businesses', async () => {
    const s = mk(20), before = db.prepare('SELECT COUNT(*) n FROM businesses').get().n;
    const fetchFn = async (u) => (u.includes('nominatim') ? res(200, NOMINATIM) : res(200, mapsPage(full)));
    const r = await A.discoverPage(db, s, 0, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.created, 0); assert.equal(r.merged, 20); assert.equal(db.prepare('SELECT COUNT(*) n FROM businesses').get().n, before);
  });
  await t('"no results" from SerpApi is NOT an error => search completed with 0', async () => {
    const s = A.createSearch(db, { category: 'zoo', city: 'Owerri', region: 'Imo', country: 'Nigeria' }).id;
    const fetchFn = async (u) => (u.includes('nominatim') ? res(200, NOMINATIM) : res(200, { error: "Google Maps hasn't returned any results for this query." }));
    const r = await A.discoverPage(db, s, 0, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.ok, true); assert.equal(A.finalizeSearch(db, s), 'completed');
  });
  await t('SerpApi 500s: bounded retries, error logged, key never leaked, search failed', async () => {
    const s = mk(20); let calls = 0;
    const fetchFn = async (u) => { if (u.includes('nominatim')) return res(200, NOMINATIM); calls++; throw new Error('boom ' + u); };
    const r = await A.discoverPage(db, s, 0, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.ok, false); assert.equal(calls, 3); assert.ok(!JSON.stringify(A.getSearch(db, s)).includes(KEY));
    assert.equal(A.finalizeSearch(db, s), 'failed');
  });
  await t('missing SERPAPI_KEY => clean error, no crash', async () => {
    const s = mk(20); const r = await A.discoverPage(db, s, 0, { fetchFn: async () => res(200, NOMINATIM), key: '', sleep: noSleep });
    assert.equal(r.ok, false); assert.ok(/SERPAPI_KEY/.test(r.error));
  });
  await t('ambiguous location (no region, matches 2 states) => clarification, nothing searched', async () => {
    const s = A.createSearch(db, { category: 'hotels', city: 'Aba', country: 'Nigeria' }).id; let maps = 0;
    const fetchFn = async (u) => { if (u.includes('nominatim')) return res(200, [{ lat: '1', lon: '1', address: { state: 'Abia' } }, { lat: '2', lon: '2', address: { state: 'Ogun' } }]); maps++; return res(200, {}); };
    const r = await A.discoverPage(db, s, 0, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.ok, false); assert.equal(r.needsClarification, true); assert.equal(maps, 0);
  });

  // ---- verification via organic results ----
  const sv = mk(20);
  A.ingest(db, sv, [
    { city: 'Owerri', country: 'Nigeria', name: 'Zenith Realty', source: 't', source_id: 'v1', phone: '08033334444', address: '2 Douglas Rd', listing_website: 'https://zenithrealty.com.ng' },
    { city: 'Owerri', country: 'Nigeria', name: 'Prime Land Agency', source: 't', source_id: 'v2', phone: '08055556666', address: '9 Wetheral Rd' },
    { city: 'Owerri', country: 'Nigeria', name: 'Timeout Estates', source: 't', source_id: 'v3', phone: '08077778888' },
  ]);
  const id = (nm) => A.listBusinesses(db, sv, { q: nm }).items[0].id;
  const organic = (rows) => ({ organic_results: rows.map(([link, title, snippet]) => ({ link, title, snippet })) });
  await t('pending lists unverified; website found (listing hint + search corroboration)', async () => {
    assert.equal(A.pendingVerification(db, sv).length, 3);
    const fetchFn = async () => res(200, organic([['https://zenithrealty.com.ng', 'Zenith Realty Owerri', 'Call 0803 333 4444']]));
    const r = await A.verifyRun(db, id('Zenith'), {}, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.status, 'website_found'); assert.equal(A.getSearch(db, sv).status, 'verifying');
  });
  await t('social + directory only => no_website_found; FB stored separately; confidence never high', async () => {
    const fetchFn = async () => res(200, organic([['https://facebook.com/primelandagency', 'Prime Land Agency', ''], ['https://jiji.ng/prime-land', 'Prime Land', '']]));
    const r = await A.verifyRun(db, id('Prime'), {}, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.status, 'no_website_found'); assert.notEqual(r.confidence, 'high');
    const b = A.listBusinesses(db, sv, { q: 'Prime' }).items[0]; assert.equal(b.official_url, null); assert.ok(b.facebook_url);
  });
  await t('all verification calls time out => verification_failed + errors => job partial', async () => {
    const fetchFn = async () => { throw new Error('timeout'); };
    const r = await A.verifyRun(db, id('Timeout'), {}, { fetchFn, key: KEY, sleep: noSleep });
    assert.equal(r.status, 'verification_failed');
    assert.equal(A.finalizeSearch(db, sv), 'partial');
  });
  await t('fresh results are not re-verified (zero API calls); failed ones are retried', async () => {
    let calls = 0; const fetchFn = async () => { calls++; return res(200, organic([])); };
    assert.ok((await A.verifyRun(db, id('Zenith'), {}, { fetchFn, key: KEY })).skipped); assert.equal(calls, 0);
    assert.deepEqual(A.pendingVerification(db, sv).map((x) => x.name), ['Timeout Estates']);
  });
  await t('intake payload carries page list; HTTP discover route requires secret', async () => {
    let sent; const s = mk(45);
    await A.triggerIntake(db, s, { url: 'http://ap.test', fetchFn: async (u, o) => { sent = JSON.parse(o.body); return res(200, {}); } });
    assert.deepEqual(sent.pages, [0, 1, 2]);
    const srv = A.makeServer(db, { AP_SHARED_SECRET: 'sek' }); await new Promise((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}/api/internal/discover`;
    const noAuth = await fetch(base, { method: 'POST', body: '{}' }); assert.equal(noAuth.status, 401);
    srv.close();
  });
  console.log(`\n${n} tests passed (fixtures only; live SerpApi, Nominatim and Activepieces NOT exercised)`);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
