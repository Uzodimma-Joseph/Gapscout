// Website gap classifier: pure logic, no network. Fed by search results gathered elsewhere
// (Activepieces HTTP steps or a worker). Never treats failures as "no website".

const SOCIAL = ['facebook.com','instagram.com','tiktok.com','linkedin.com','x.com','twitter.com','youtube.com','wa.me','whatsapp.com','threads.net'];
const DIRECTORY = ['google.com','yelp.com','tripadvisor','foursquare.com','mapquest.com','bing.com','wikipedia.org','linktr.ee','booking.com','jiji.ng','businesslist','cylex','yellowpages','vconnect','ngpages','nairaland.com','hotels.ng','propertypro.ng','nigeriapropertycentre','openstreetmap.org'];
const STOP = new Set(['ltd','limited','nig','nigeria','and','the','company','co','plc','inc','enterprises','enterprise','services','service','global','group','of','for']);

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
const isSocial = (h) => SOCIAL.some((d) => h === d || h.endsWith('.' + d));
const isDirectory = (h) => DIRECTORY.some((d) => h.includes(d));
const tokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
const digits = (s) => (s || '').replace(/\D/g, '');

function scoreCandidate(biz, r) {
  const h = host(r.url);
  const nameTok = tokens(biz.name);
  const domain = (h || '').replace(/\.[a-z.]{2,}$/, '').replace(/[^a-z0-9]/g, '');
  const title = (r.title || '').toLowerCase();
  const text = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
  const reasons = [];
  let score = 0;
  if (nameTok.length) {
    const inDomain = nameTok.filter((t) => domain.includes(t)).length / nameTok.length;
    const inTitle = nameTok.filter((t) => title.includes(t)).length / nameTok.length;
    if (inDomain) { score += 0.4 * inDomain; reasons.push(`domain matches ${Math.round(inDomain * 100)}% of name words`); }
    if (inTitle) { score += 0.2 * inTitle; reasons.push(`page title matches ${Math.round(inTitle * 100)}% of name words`); }
  }
  const p = digits(biz.phone).slice(-9);
  if (p.length === 9 && digits(text).includes(p)) { score += 0.4; reasons.push('phone number appears on page'); }
  if (biz.city && text.includes(biz.city.toLowerCase())) { score += 0.1; reasons.push('city mentioned'); }
  return { url: r.url, host: h, score: Math.min(1, +score.toFixed(2)), reasons };
}

/**
 * biz: {name, phone?, city?, listingWebsite?}
 * checks: [{type:'name_location'|'name_phone'|'name_address'|'name_category', ok:boolean, results:[{url,title,snippet}], error?}]
 */
function classify(biz, checks = []) {
  const now = new Date().toISOString();
  const completed = checks.filter((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);
  const base = { verifiedAt: now, checksRun: checks.map((c) => ({ type: c.type, ok: c.ok, error: c.error || null })), socialLinks: [], directoryLinks: [], officialUrl: null };

  const buckets = { candidates: [] };
  const seen = new Set();
  const add = (url, r) => {
    const h = host(url);
    if (!h || seen.has(url)) return;
    seen.add(url);
    if (isSocial(h)) base.socialLinks.push(url);
    else if (isDirectory(h)) base.directoryLinks.push(url);
    else buckets.candidates.push(scoreCandidate(biz, r));
  };

  // Check A: listing field (a hint, still scored as a candidate)
  if (biz.listingWebsite) add(biz.listingWebsite, { url: biz.listingWebsite, title: '', snippet: '' });
  // Check B/C/D: search results
  completed.forEach((c) => (c.results || []).forEach((r) => add(r.url, r)));

  const best = buckets.candidates.sort((a, b) => b.score - a.score)[0];
  const listingIsOfficial = biz.listingWebsite && best && best.url === biz.listingWebsite && !isSocial(host(biz.listingWebsite)) && !isDirectory(host(biz.listingWebsite));

  if (best && (best.score >= 0.6 || listingIsOfficial)) {
    return { ...base, status: 'website_found', confidence: best.score >= 0.8 ? 'high' : 'medium', officialUrl: best.url,
      reasons: [...best.reasons, ...(listingIsOfficial ? ['listed as website in source record'] : [])] };
  }
  if (best && best.score >= 0.3) {
    return { ...base, status: 'uncertain', confidence: 'low', candidateUrl: best.url,
      reasons: ['possible site found but identity not corroborated', ...best.reasons] };
  }
  if (completed.length < 2) {
    const why = failed.length ? 'too many verification checks failed' : 'too few checks run';
    return { ...base, status: failed.length ? 'verification_failed' : 'uncertain', confidence: 'none',
      reasons: [why, ...failed.map((f) => `${f.type}: ${f.error || 'failed'}`)] };
  }
  // No credible site after >=2 successful checks. Absence of evidence is never "high".
  const strong = completed.length >= 4 && failed.length === 0 && completed.some((c) => c.type === 'name_phone');
  return { ...base, status: 'no_website_found', confidence: strong ? 'medium' : 'low',
    reasons: [`${completed.length} checks found no credible official site`, ...(failed.length ? [`${failed.length} check(s) failed`] : []),
      ...(base.socialLinks.length ? ['social profile(s) found, not counted as website'] : [])] };
}

module.exports = { classify, scoreCandidate };
