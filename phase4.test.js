// Server-side checks for the dashboard. The browser UI itself was NOT run in a browser here (syntax-checked only).
const assert = require('assert');
const A = require('./app');
const db = A.openDb();
let n = 0; const t = (name, fn) => Promise.resolve(fn()).then(() => console.log('PASS', ++n, name));
(async () => {
  const srv = A.makeServer(db, { DASHBOARD_KEY: 'k3y', AP_SHARED_SECRET: 'sek' }); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { 'x-access-key': 'k3y', 'content-type': 'application/json' };
  await t('dashboard HTML served; health is public', async () => {
    const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.ok((await r.text()).includes('GapScout'));
    assert.equal((await fetch(base + '/api/health')).status, 200);
  });
  await t('API needs access key (public), internal needs secret (not dashboard key)', async () => {
    assert.equal((await fetch(base + '/api/searches')).status, 401);
    assert.equal((await fetch(base + '/api/searches', { headers: { 'x-access-key': 'wrong' } })).status, 401);
    assert.equal((await fetch(base + '/api/searches', { headers: H })).status, 200);
    assert.equal((await fetch(base + '/api/internal/discover', { method: 'POST', headers: H, body: '{}' })).status, 401);
  });
  let sid;
  await t('create -> list previous searches -> results -> CSV export all pages', async () => {
    const r = await fetch(base + '/api/searches', { method: 'POST', headers: H, body: JSON.stringify({ query: 'hotels in Enugu, Enugu, Nigeria', limit: 150 }) });
    sid = (await r.json()).id;
    const hist = await (await fetch(base + '/api/searches', { headers: H })).json(); assert.equal(hist.items[0].id, sid);
    A.ingest(db, sid, Array.from({ length: 120 }, (_, i) => ({ city: 'Enugu', country: 'Nigeria', name: `Hotel Number${i} Alpha${i}`, source: 't', source_id: 'e' + i })));
    const csv = await (await fetch(`${base}/api/searches/${sid}/export.csv`, { headers: H })).text();
    assert.equal(csv.split('\n').length, 121);
  });
  await t('re-verify without SERPAPI_KEY => verification_failed, nothing crashes', async () => {
    delete process.env.SERPAPI_KEY;
    const id = A.listBusinesses(db, sid).items[0].id;
    const j = await (await fetch(`${base}/api/businesses/${id}/reverify`, { method: 'POST', headers: H })).json();
    assert.equal(j.status, 'verification_failed');
  });
  srv.close(); console.log(`\n${n} tests passed`);
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
