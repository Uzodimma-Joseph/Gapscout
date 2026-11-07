const { classify } = require('./classifier');
const assert = require('assert');
const biz = { name: 'Heritage Homes Nig Ltd', phone: '+234 803 123 4567', city: 'Owerri' };
const ok = (type, results) => ({ type, ok: true, results });

// 1 real site corroborated
let r = classify(biz, [ok('name_location', [{ url: 'https://heritagehomes.ng', title: 'Heritage Homes Owerri', snippet: 'Call 0803 123 4567' }]), ok('name_phone', [])]);
assert.equal(r.status, 'website_found');

// 2 only facebook + directory => no website, social kept separate
r = classify(biz, [ok('name_location', [{ url: 'https://facebook.com/heritagehomes', title: 'x', snippet: '' }, { url: 'https://jiji.ng/heritage', title: 'x', snippet: '' }]), ok('name_phone', []), ok('name_address', []), ok('name_category', [])]);
assert.equal(r.status, 'no_website_found'); assert.equal(r.socialLinks.length, 1); assert.notEqual(r.confidence, 'high');

// 3 all checks fail => verification_failed, NOT no_website
r = classify(biz, [{ type: 'name_location', ok: false, error: 'timeout' }, { type: 'name_phone', ok: false, error: '429' }]);
assert.equal(r.status, 'verification_failed');

// 4 weak lookalike => uncertain
r = classify(biz, [ok('name_location', [{ url: 'https://heritage-hotels.com', title: 'Heritage Hotels Lagos', snippet: '' }]), ok('name_phone', [])]);
assert.equal(r.status, 'uncertain');
console.log('all 4 tests passed');
