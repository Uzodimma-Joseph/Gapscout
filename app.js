// GapScout backend. Node 22+, no npm dependencies (uses node:sqlite).
const { DatabaseSync } = require('node:sqlite');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { classify } = require('./classifier');
const serp = require('./serp');

const now = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const STALE_DAYS = 30;

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

// ---------- normalization ----------
const STOP = new Set(['ltd', 'limited', 'nig', 'nigeria', 'and', 'the', 'co', 'plc', 'inc', 'company']);
const nameTokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
const nameNorm = (s) => nameTokens(s).join(' ');
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((x) => B.has(x)).length / new Set([...A, ...B]).size;
};
function normPhone(p) {
  if (!p) return null;
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0\d{10}$/.test(s)) s = '+234' + s.slice(1);
  else if (/^234\d{10}$/.test(s)) s = '+' + s;
  return s.replace(/\D/g, '').length >= 7 ? s : null;
}
const last9 = (p) => (p || '').replace(/\D/g, '').slice(-9);
const cleanUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const cleanEmail = (e) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '') ? e.toLowerCase() : null); // syntax only
const clean = (s, n = 200) => (s == null ? null : String(s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null);
const distM = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function completeness(b) {
  const f = ['phone', 'email', 'address', 'description', 'image_url', 'lat', 'listing_url'];
  const have = f.filter((k) => b[k] != null).length + (b.facebook_url || b.instagram_url || b.linkedin_url ? 1 : 0);
  return +(have / (f.length + 1)).toFixed(2);
}

// ---------- searches ----------
function parseQuery(q) {
  const m = /^(.+?)\s+in\s+(.+)$/i.exec(q || '');
  if (!m) return {};
  const parts = m[2].split(',').map((s) => s.trim());
  return { category: m[1].trim(), city: parts[0], region: parts[1], country: parts[2] };
}

function createSearch(db, input) {
  const p = { ...parseQuery(input.query), ...Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'query' && v)) };
  const category = clean(p.category, 80), city = clean(p.city, 80);
  if (!category) return { error: 'category is required' };
  if (!city) return { error: 'city is required: location is ambiguous, please specify a city, town or LGA' };
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 50, 1), 500);
  const id = uid('srch'), t = now();
  db.prepare('INSERT INTO searches (id,category,country,region,city,area,result_limit,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, category, clean(p.country, 80), clean(p.region, 80), city, clean(p.area, 80), limit, t, t);
  return { id };
}

function setStatus(db, id, status) {
  db.prepare('UPDATE searches SET status=?, updated_at=? WHERE id=?').run(status, now(), id);
}
function logError(db, searchId, step, source, message) {
  db.prepare('INSERT INTO error_log (search_id,step,source,message,created_at) VALUES (?,?,?,?,?)').run(searchId, step, source, clean(message, 500), now());
}
function logUsage(db, searchId, provider, requests = 1, cost = null) {
  db.prepare('INSERT INTO api_usage (search_id,provider,requests,est_cost_usd,created_at) VALUES (?,?,?,?,?)').run(searchId, provider, requests, cost, now());
}

function getSearch(db, id) {
  const s = db.prepare('SELECT * FROM searches WHERE id=?').get(id);
  if (!s) return null;
  const c = db.prepare(`SELECT COUNT(*) discovered, SUM(b.verified_at IS NOT NULL) verified FROM search_businesses sb JOIN businesses b ON b.id=sb.business_id WHERE sb.search_id=?`).get(id);
  const errors = db.prepare('SELECT step,source,message,created_at FROM error_log WHERE search_id=? ORDER BY id').all(id);
  return { ...s, discovered: c.discovered, verified: c.verified || 0, errors };
}

// A search is "completed" only if nothing failed; partial if some data but errors; failed if no data and errors.
function finalizeSearch(db, id) {
  const s = getSearch(db, id);
  const status = s.errors.length === 0 ? 'completed' : s.discovered > 0 ? 'partial' : 'failed';
  db.prepare('UPDATE searches SET status=?, updated_at=?, completed_at=? WHERE id=?').run(status, now(), now(), id);
  return status;
}

// ---------- ingest + dedupe ----------
function findMatch(db, c) {
  if (c.source && c.source_id) {
    const r = db.prepare('SELECT business_id FROM business_sources WHERE source=? AND source_id=?').get(c.source, c.source_id);
    if (r) return r.business_id;
  }
  const toks = nameTokens(c.name);
  const rows = db.prepare('SELECT id,name,phone,lat,lng,address FROM businesses WHERE city IS ? AND country IS ?').all(c.city, c.country);
  for (const r of rows) {
    const sim = jaccard(toks, nameTokens(r.name));
    // Similar names alone never merge: need a second, independent identifier.
    if (c.phone && r.phone && last9(c.phone) === last9(r.phone) && sim >= 0.5) return r.id;
    if (c.lat != null && r.lat != null && distM(c, r) <= 100 && sim >= 0.6) return r.id;
    if (c.address && r.address && nameNorm(c.address) === nameNorm(r.address) && sim >= 0.8) return r.id;
  }
  return null;
}

const FIELDS = ['category', 'subcategory', 'description', 'image_url', 'image_source', 'phone', 'email', 'whatsapp', 'address', 'city', 'region', 'country', 'postal_code', 'lat', 'lng', 'facebook_url', 'instagram_url', 'linkedin_url', 'listing_url', 'listing_website'];

function normalizeCandidate(c) {
  const n = {
    name: clean(c.name, 160), source: clean(c.source, 40), source_id: clean(c.source_id, 120),
    category: clean(c.category, 80), subcategory: clean(c.subcategory, 80), description: clean(c.description, 500),
    image_url: cleanUrl(c.image_url), image_source: clean(c.image_source), phone: normPhone(c.phone), email: cleanEmail(c.email),
    whatsapp: normPhone(c.whatsapp), address: clean(c.address), city: clean(c.city, 80), region: clean(c.region, 80),
    country: clean(c.country, 80), postal_code: clean(c.postal_code, 20),
    lat: Number.isFinite(+c.lat) && c.lat != null ? +c.lat : null, lng: Number.isFinite(+c.lng) && c.lng != null ? +c.lng : null,
    facebook_url: cleanUrl(c.facebook_url), instagram_url: cleanUrl(c.instagram_url), linkedin_url: cleanUrl(c.linkedin_url),
    listing_url: cleanUrl(c.listing_url), listing_website: cleanUrl(c.listing_website), raw: c.raw || null,
  };
  return n;
}

function ingest(db, searchId, candidates) {
  const out = { created: 0, merged: 0, skipped: 0 };
  const limit = db.prepare('SELECT result_limit FROM searches WHERE id=?').get(searchId).result_limit;
  for (const raw of candidates) {
    const c = normalizeCandidate(raw);
    if (!c.name) { out.skipped++; continue; }
    const have = db.prepare('SELECT COUNT(*) n FROM search_businesses WHERE search_id=?').get(searchId).n;
    let bizId = findMatch(db, c);
    if (!bizId && have >= limit) { out.skipped++; continue; }
    const t = now();
    if (bizId) {
      // Incremental enrichment: only fill gaps, never overwrite collected data.
      const cur = db.prepare('SELECT * FROM businesses WHERE id=?').get(bizId);
      const patch = FIELDS.filter((k) => cur[k] == null && c[k] != null);
      if (patch.length) db.prepare(`UPDATE businesses SET ${patch.map((k) => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...patch.map((k) => c[k]), t, bizId);
      out.merged++;
    } else {
      bizId = uid('biz');
      db.prepare(`INSERT INTO businesses (id,name,name_norm,${FIELDS.join(',')},discovered_at,updated_at) VALUES (?,?,?,${FIELDS.map(() => '?').join(',')},?,?)`)
        .run(bizId, c.name, nameNorm(c.name), ...FIELDS.map((k) => c[k]), t, t);
      out.created++;
    }
    if (c.source) {
      db.prepare('INSERT OR IGNORE INTO business_sources (business_id,source,source_id,url,raw_json,fetched_at) VALUES (?,?,?,?,?,?)')
        .run(bizId, c.source, c.source_id, c.listing_url, c.raw ? JSON.stringify(c.raw) : null, t);
    }
    db.prepare('INSERT OR IGNORE INTO search_businesses (search_id,business_id) VALUES (?,?)').run(searchId, bizId);
    const row = db.prepare('SELECT * FROM businesses WHERE id=?').get(bizId);
    db.prepare('UPDATE businesses SET completeness=? WHERE id=?').run(completeness(row), bizId);
  }
  return out;
}

// ---------- verification ----------
const isFresh = (b) => !!b.verified_at && Date.now() - Date.parse(b.verified_at) < STALE_DAYS * 864e5 && b.website_status !== 'verification_failed';

function verifyBusiness(db, bizId, checks, { force = false } = {}) {
  const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(bizId);
  if (!b) return { error: 'not found' };
  if (isFresh(b) && !force) return { skipped: 'recently verified', status: b.website_status };
  const r = classify({ name: b.name, phone: b.phone, city: b.city, listingWebsite: b.listing_website }, checks);
  db.prepare('INSERT INTO verifications (business_id,status,confidence,official_url,evidence_json,verified_at) VALUES (?,?,?,?,?,?)')
    .run(bizId, r.status, r.confidence, r.officialUrl, JSON.stringify(r), r.verifiedAt);
  // Social links go to their own fields, never to official_url.
  const soc = (d) => r.socialLinks.find((u) => u.includes(d)) || null;
  db.prepare(`UPDATE businesses SET website_status=?, website_confidence=?, official_url=?, verified_at=?, verification_notes=?,
    facebook_url=COALESCE(facebook_url,?), instagram_url=COALESCE(instagram_url,?), linkedin_url=COALESCE(linkedin_url,?), updated_at=? WHERE id=?`)
    .run(r.status, r.confidence, r.officialUrl, r.verifiedAt, r.reasons.join('; '), soc('facebook.com'), soc('instagram.com'), soc('linkedin.com'), now(), bizId);
  return r;
}

// ---------- orchestration (called by Activepieces) ----------
const PAGE = 20; // SerpApi Google Maps returns ~20 results per page

async function discoverPage(db, searchId, page = 0, deps = {}) {
  const s = db.prepare('SELECT * FROM searches WHERE id=?').get(searchId);
  if (!s) return { ok: false, error: 'search not found' };
  if (s.discovery_done && page > 0) return { ok: true, skipped: 'no more results' }; // saves SerpApi credits
  if (page === 0) setStatus(db, searchId, 'discovering');
  if (s.lat == null) {
    const g = await serp.geocode(s, deps);
    logUsage(db, searchId, 'nominatim', 1, 0);
    if (!g.ok) { logError(db, searchId, 'geocode', 'nominatim', g.error); return { ok: false, error: g.error, needsClarification: !!g.ambiguous || /not found/.test(g.error) }; }
    db.prepare('UPDATE searches SET lat=?, lng=?, resolved_location=? WHERE id=?').run(g.lat, g.lng, g.display, searchId);
    s.lat = g.lat; s.lng = g.lng;
  }
  const r = await serp.serpGet(serp.mapsParams(s, { ll: `@${s.lat},${s.lng},13z`, start: page * PAGE }), deps);
  logUsage(db, searchId, 'serpapi_maps', 1, null); // cost depends on your SerpApi plan
  if (!r.ok) { logError(db, searchId, 'discovery', 'serpapi_maps', r.error); return { ok: false, error: r.error }; }
  const cands = serp.normalizeMaps(r.json).map((c) => ({ ...c, city: s.city, region: s.region, country: s.country, category: c.category || s.category }));
  const res = ingest(db, searchId, cands);
  const total = db.prepare('SELECT COUNT(*) n FROM search_businesses WHERE search_id=?').get(searchId).n;
  const hasMore = cands.length >= PAGE && total < s.result_limit && (page + 1) * PAGE < s.result_limit;
  if (!hasMore) db.prepare('UPDATE searches SET discovery_done=1 WHERE id=?').run(searchId);
  return { ok: true, found: cands.length, ...res, hasMore };
}

function pendingVerification(db, searchId) {
  setStatus(db, searchId, 'verifying');
  const rows = db.prepare('SELECT b.* FROM search_businesses sb JOIN businesses b ON b.id=sb.business_id WHERE sb.search_id=?').all(searchId);
  return rows.filter((b) => !isFresh(b)).map((b) => ({ businessId: b.id, name: b.name }));
}

async function verifyRun(db, bizId, { force = false, deep = false } = {}, deps = {}) {
  const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(bizId);
  if (!b) return { error: 'not found' };
  if (isFresh(b) && !force) return { skipped: 'recently verified', status: b.website_status };
  const link = db.prepare('SELECT search_id FROM search_businesses WHERE business_id=? ORDER BY rowid DESC LIMIT 1').get(bizId);
  const sid = link && link.search_id;
  const checks = [];
  for (const q of serp.verificationQueries(b, deep)) {
    const r = await serp.serpGet(q.params, deps);
    logUsage(db, sid, 'serpapi_google', 1, null);
    if (r.ok) checks.push({ type: q.type, ok: true, results: serp.normalizeOrganic(r.json) });
    else { checks.push({ type: q.type, ok: false, error: r.error }); logError(db, sid, 'verification', 'serpapi_google', `${b.name}: ${q.type}: ${r.error}`); }
  }
  return verifyBusiness(db, bizId, checks, { force: true });
}

// ---------- queries ----------
const SORTS = { name: 'b.name COLLATE NOCASE', completeness: 'b.completeness DESC', confidence: "CASE b.website_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC", location: 'b.city, b.address' };

function listBusinesses(db, searchId, f = {}) {
  const where = ['sb.search_id=?'], args = [searchId];
  if (f.status) { const s = String(f.status).split(','); where.push(`b.website_status IN (${s.map(() => '?').join(',')})`); args.push(...s); }
  if (f.hasPhone) where.push('b.phone IS NOT NULL');
  if (f.hasEmail) where.push('b.email IS NOT NULL');
  if (f.hasAddress) where.push('b.address IS NOT NULL');
  if (f.hasSocial) where.push('(b.facebook_url IS NOT NULL OR b.instagram_url IS NOT NULL OR b.linkedin_url IS NOT NULL)');
  if (f.q) { where.push('(b.name LIKE ? OR b.address LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`); }
  const page = Math.max(parseInt(f.page, 10) || 1, 1), size = Math.min(parseInt(f.pageSize, 10) || 20, 100);
  const base = `FROM search_businesses sb JOIN businesses b ON b.id=sb.business_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...args).n;
  const rows = db.prepare(`SELECT b.* ${base} ORDER BY ${SORTS[f.sort] || SORTS.name} LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  return { total, page, pageSize: size, items: rows };
}

const CSV_COLS = ['name', 'category', 'phone', 'email', 'address', 'city', 'region', 'website_status', 'website_confidence', 'official_url', 'facebook_url', 'instagram_url', 'listing_url', 'verified_at'];
function toCsv(rows) {
  const esc = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c])).join(','))].join('\n');
}

// ---------- Activepieces hand-off ----------
async function triggerIntake(db, searchId, { url = process.env.AP_WEBHOOK_URL, secret = process.env.AP_SHARED_SECRET, fetchFn = fetch } = {}) {
  if (!url) return { queued: true, note: 'AP_WEBHOOK_URL not set; job left queued' };
  const s = getSearch(db, searchId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-secret': secret || '' },
        body: JSON.stringify({ searchId, pages: Array.from({ length: Math.min(Math.ceil(s.result_limit / PAGE), 5) }, (_, i) => i), category: s.category, city: s.city, region: s.region, country: s.country, area: s.area, limit: s.result_limit }), signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(db, searchId, 'discovering');
      return { triggered: true };
    } catch (e) {
      logError(db, searchId, 'intake', 'activepieces', `attempt ${attempt + 1}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    }
  }
  setStatus(db, searchId, 'failed');
  return { triggered: false };
}

// ---------- HTTP ----------
function makeServer(db, env = process.env) {
  const hits = new Map();
  const limited = (ip) => { const t = Date.now(), h = (hits.get(ip) || []).filter((x) => t - x < 6e4); h.push(t); hits.set(ip, h); return h.length > 60; };
  const body = (req) => new Promise((res, rej) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); });

  return http.createServer(async (req, res) => {
    const send = (code, obj, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
    try {
      if (limited(req.socket.remoteAddress)) return send(429, { error: 'rate limited' });
      const u = new URL(req.url, 'http://x'), p = u.pathname.split('/').filter(Boolean), q = Object.fromEntries(u.searchParams);
      const isAP = req.headers['x-secret'] && req.headers['x-secret'] === env.AP_SHARED_SECRET; // Activepieces callbacks only
      if (req.method === 'GET' && p.length === 0) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
      if (p[0] !== 'api') return send(404, { error: 'not found' });
      if (p[1] === 'health') return send(200, { ok: true });
      if (env.DASHBOARD_KEY && p[1] !== 'internal') { // dashboard access key; protects SerpApi credits
        const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
        if (!crypto.timingSafeEqual(sha(req.headers['x-access-key'] || ''), sha(env.DASHBOARD_KEY))) return send(401, { error: 'access key required' });
      }

      if (req.method === 'POST' && p[1] === 'searches' && !p[2]) {
        const r = createSearch(db, await body(req));
        if (r.error) return send(400, r);
        triggerIntake(db, r.id).catch(() => {});
        return send(202, { id: r.id, status: 'queued' });
      }
      if (req.method === 'GET' && p[1] === 'searches' && !p[2]) return send(200, { items: db.prepare(`SELECT s.id,s.category,s.city,s.region,s.country,s.status,s.created_at,
        (SELECT COUNT(*) FROM search_businesses WHERE search_id=s.id) discovered FROM searches s ORDER BY s.created_at DESC LIMIT 30`).all() });
      if (req.method === 'GET' && p[1] === 'searches' && p[2] && !p[3]) { const s = getSearch(db, p[2]); return s ? send(200, s) : send(404, { error: 'not found' }); }
      if (req.method === 'GET' && p[3] === 'businesses') return send(200, listBusinesses(db, p[2], q));
      if (req.method === 'GET' && p[3] === 'export.csv') {
        const all = [];
        for (let pg = 1; pg <= 50; pg++) { const r = listBusinesses(db, p[2], { ...q, pageSize: 100, page: pg }); all.push(...r.items); if (all.length >= r.total) break; }
        const ids = q.ids ? new Set(q.ids.split(',')) : null;
        return send(200, toCsv(ids ? all.filter((b) => ids.has(b.id)) : all), 'text/csv');
      }
      if (req.method === 'POST' && p[3] === 'retry') { setStatus(db, p[2], 'queued'); return send(202, await triggerIntake(db, p[2])); }
      if (req.method === 'POST' && p[1] === 'businesses' && p[3] === 'reverify') return send(200, await verifyRun(db, p[2], { force: true }));
      if (req.method === 'GET' && p[1] === 'businesses' && p[2]) {
        const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(p[2]);
        if (!b) return send(404, { error: 'not found' });
        return send(200, { ...b, sources: db.prepare('SELECT source,url,fetched_at FROM business_sources WHERE business_id=?').all(p[2]),
          verifications: db.prepare('SELECT status,confidence,official_url,evidence_json,verified_at FROM verifications WHERE business_id=? ORDER BY id DESC').all(p[2]).map((v) => ({ ...v, evidence: JSON.parse(v.evidence_json) })) });
      }
      // ---- Activepieces callbacks (shared-secret protected) ----
      if (p[1] === 'internal') {
        if (!isAP) return send(401, { error: 'unauthorized' });
        if (req.method === 'GET' && p[2] === 'searches' && p[4] === 'pending') return send(200, { items: pendingVerification(db, p[3]) });
        const b = await body(req);
        if (p[2] === 'ingest') return send(200, ingest(db, b.searchId, b.candidates || []));
        if (p[2] === 'status') { setStatus(db, b.searchId, b.status); return send(200, { ok: true }); }
        if (p[2] === 'error') { logError(db, b.searchId, b.step, b.source, b.message); return send(200, { ok: true }); }
        if (p[2] === 'usage') { logUsage(db, b.searchId, b.provider, b.requests, b.cost); return send(200, { ok: true }); }
        if (p[2] === 'discover') return send(200, await discoverPage(db, b.searchId, b.page || 0));
        if (p[2] === 'verify-run') return send(200, await verifyRun(db, b.businessId, { force: !!b.force, deep: !!b.deep }));
        if (p[2] === 'verify') return send(200, verifyBusiness(db, b.businessId, b.checks || [], { force: !!b.force }));
        if (p[2] === 'finalize') return send(200, { status: finalizeSearch(db, b.searchId) });
      }
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: 'internal error' }); }
  });
}

module.exports = { discoverPage, verifyRun, pendingVerification, openDb, createSearch, getSearch, ingest, verifyBusiness, listBusinesses, finalizeSearch, logError, toCsv, triggerIntake, makeServer, normPhone };

if (require.main === module) {
  const db = openDb(process.env.DB_FILE || 'gapscout.db');
  makeServer(db).listen(process.env.PORT || 3000, () => console.log('GapScout API on', process.env.PORT || 3000));
}
