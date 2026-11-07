// FIXTURE-BASED tests: no live providers or Activepieces were contacted.
const assert = require('assert');
const A = require('./app');
const db = A.openDb();
const mk = (o = {}) => A.createSearch(db, { query: 'real estate agencies in Owerri, Imo State, Nigeria', ...o });
const base = { city: 'Owerri', country: 'Nigeria' };
const c1 = { ...base, name: 'Heritage Homes Nig Ltd', source: 'osm', source_id: 'n1', phone: '0803 123 4567', address: '12 Douglas Rd', lat: 5.485, lng: 7.035 };
let n = 0; const t = (name, fn) => Promise.resolve(fn()).then(() => console.log('PASS', ++n, name));

(async () => {
  await t('NL query parsed; ambiguous location rejected', () => {
    const s = mk(); assert.ok(s.id);
    assert.ok(A.createSearch(db, { query: 'hotels', category: 'hotels' }).error);
  });
  await t('#7 duplicates across sources merge (same phone + similar name), fill gaps only', () => {
    const s = mk().id;
    const r = A.ingest(db, s, [c1, { ...base, name: 'Heritage Homes', source: 'directoryX', source_id: 'd9', phone: '+2348031234567', email: 'info@heritage.ng', description: 'x' }]);
    assert.deepStrictEqual([r.created, r.merged], [1, 1]);
    const b = A.listBusinesses(db, s).items[0];
    assert.equal(b.email, 'info@heritage.ng'); assert.equal(b.phone, '+2348031234567'); assert.equal(b.address, '12 Douglas Rd');
  });
  await t('similar names alone do NOT merge', () => {
    const s = mk().id;
    const r = A.ingest(db, s, [{ ...base, name: 'Heritage Homes', source: 'osm', source_id: 'z1', phone: '08099999999' }]);
    assert.equal(r.created, 1);
  });
  await t('#12 repeated search reuses records, no new duplicates', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM businesses').get().n;
    const s = mk().id; const r = A.ingest(db, s, [c1]);
    assert.equal(r.merged, 1); assert.equal(db.prepare('SELECT COUNT(*) n FROM businesses').get().n, before);
    assert.equal(A.listBusinesses(db, s).total, 1);
  });
  await t('#6 incomplete record keeps nulls; invalid email/url dropped', () => {
    const s = mk().id; A.ingest(db, s, [{ ...base, name: 'Bare Realty', source: 'osm', source_id: 'b1', email: 'nope', listing_url: 'javascript:alert(1)' }]);
    const b = A.listBusinesses(db, s, { q: 'Bare' }).items[0];
    assert.equal(b.phone, null); assert.equal(b.email, null); assert.equal(b.listing_url, null); assert.ok(b.completeness < 0.2);
  });
  await t('#10 no matches, no errors => completed with 0 results', () => {
    const s = mk().id; assert.equal(A.finalizeSearch(db, s), 'completed'); assert.equal(A.getSearch(db, s).discovered, 0);
  });
  await t('#8/#11 source error + other source data => partial (not completed)', () => {
    const s = mk().id; A.ingest(db, s, [{ ...base, name: 'Okay Estates', source: 'osm', source_id: 'o1' }]);
    A.logError(db, s, 'discovery', 'overpass', 'HTTP 504');
    assert.equal(A.finalizeSearch(db, s), 'partial'); assert.equal(A.getSearch(db, s).errors[0].source, 'overpass');
  });
  await t('#8 all sources fail, no data => failed', () => {
    const s = mk().id; A.logError(db, s, 'discovery', 'overpass', 'down'); assert.equal(A.finalizeSearch(db, s), 'failed');
  });
  const s = mk().id; A.ingest(db, s, [{ ...base, name: 'Prime Land Agency', source: 'osm', source_id: 'p1', phone: '08011112222' }]);
  const id = A.listBusinesses(db, s).items[0].id;
  const ok = (type, results = []) => ({ type, ok: true, results });
  await t('#9 timeouts => verification_failed, not no_website', () => {
    const r = A.verifyBusiness(db, id, [{ type: 'name_location', ok: false, error: 'timeout' }, { type: 'name_phone', ok: false, error: 'timeout' }]);
    assert.equal(r.status, 'verification_failed');
  });
  await t('failed verification is retried (not blocked by freshness)', () => {
    const r = A.verifyBusiness(db, id, [ok('name_location', [{ url: 'https://facebook.com/primeland', title: 'Prime Land', snippet: '' }]), ok('name_phone'), ok('name_address'), ok('name_category')]);
    assert.equal(r.status, 'no_website_found');
  });
  await t('#5 social-only: stays no_website, FB stored separately, official_url null', () => {
    const b = A.listBusinesses(db, s).items[0];
    assert.equal(b.official_url, null); assert.ok(b.facebook_url.includes('facebook.com'));
  });
  await t('fresh verification not repeated unless forced', () => {
    assert.ok(A.verifyBusiness(db, id, []).skipped);
    assert.ok(!A.verifyBusiness(db, id, [ok('name_location'), ok('name_phone')], { force: true }).skipped);
  });
  await t('#3 website found', () => {
    const s2 = mk().id; A.ingest(db, s2, [{ ...base, name: 'Zenith Realty', source: 'osm', source_id: 'w1', phone: '08033334444' }]);
    const b = A.listBusinesses(db, s2).items[0];
    const r = A.verifyBusiness(db, b.id, [ok('name_location', [{ url: 'https://zenithrealty.com.ng', title: 'Zenith Realty Owerri', snippet: '0803 333 4444' }]), ok('name_phone')]);
    assert.equal(r.status, 'website_found');
    assert.equal(A.listBusinesses(db, s2, { status: 'website_found' }).total, 1);
    assert.equal(A.listBusinesses(db, s2, { status: 'no_website_found' }).total, 0);
  });
  await t('CSV export escapes quotes and neutralises formulas', () => {
    const csv = A.toCsv([{ name: '=cmd|x', address: 'A "B", C' }]);
    assert.ok(csv.includes("'=cmd|x")); assert.ok(csv.includes('"A ""B"", C"'));
  });
  await t('result limit enforced', () => {
    const s3 = mk({ limit: 2 }).id;
    const r = A.ingest(db, s3, [1, 2, 3, 4].map((i) => ({ ...base, name: `Biz Number${i} Alpha${i}`, source: 'osm', source_id: 'L' + i })));
    assert.equal(r.created, 2); assert.equal(r.skipped, 2);
  });
  await t('Activepieces unreachable => bounded retries then job failed with logged errors', async () => {
    const s4 = mk().id;
    const r = await A.triggerIntake(db, s4, { url: 'http://ap.invalid', fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(r.triggered, false); assert.equal(A.getSearch(db, s4).status, 'failed'); assert.equal(A.getSearch(db, s4).errors.length, 3);
  });
  await t('HTTP: internal routes need secret; intake -> ingest -> list works', async () => {
    const srv = A.makeServer(db, { AP_SHARED_SECRET: 'testsecret' });
    await new Promise((r) => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
    const J = (m, p, b, h = {}) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b && JSON.stringify(b) }).then(async (r) => [r.status, await r.json().catch(() => null)]);
    const [st, s5] = await J('POST', '/api/searches', { category: 'hotels', city: 'Enugu', country: 'Nigeria' });
    assert.equal(st, 202);
    assert.equal((await J('POST', '/api/internal/ingest', { searchId: s5.id, candidates: [] }))[0], 401);
    const h = { 'x-secret': 'testsecret' };
    const [, r] = await J('POST', '/api/internal/ingest', { searchId: s5.id, candidates: [{ name: 'Grand Hotel', city: 'Enugu', country: 'Nigeria', source: 'osm', source_id: 'h1' }] }, h);
    assert.equal(r.created, 1);
    const [, list] = await J('GET', `/api/searches/${s5.id}/businesses`); assert.equal(list.total, 1);
    assert.equal((await J('GET', '/api/searches/nope'))[0], 404);
    srv.close();
  });
  console.log(`\n${n} tests passed (fixtures only; no live provider or Activepieces tested)`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
