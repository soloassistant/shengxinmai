/* 手填到手价清单 · 断言（可复跑）：node .tmp-verify/manual-basket-test.js */
const assert = require('node:assert/strict');
const path = require('node:path');
const M = require(path.join(__dirname, '..', 'manual-basket.js'));
const nameOf = (id) => ({ jd: '京东', tb: '淘宝', pdd: '拼多多' }[id] || id);

/* ① 3 件各填价 → 总计等于三者之和 */
const items3 = [
  { q: '猫粮', offers: [{ platform: 'jd', price: '89.00' }] },
  { q: '洗衣液', offers: [{ platform: 'tb', price: '49.90' }] },
  { q: 'AirPods Pro 3', offers: [{ platform: 'pdd', price: '199.00' }] },
];
const r1 = M.compute(items3);
assert.equal(r1.total, 337.9);
assert.match(M.summaryHtml(r1, nameOf), /¥337\.90/);
console.log('PASS ① 3 件总计 = 89.00 + 49.90 + 199.00 = ¥337.90');

/* ② 同一店铺两件 → 该店铺小计正确 */
const r2 = M.compute([
  { q: 'A', offers: [{ platform: 'jd', price: '89' }] },
  { q: 'B', offers: [{ platform: 'jd', price: '59' }] },
]);
const jd = r2.groups.find((g) => g.platform === 'jd');
assert.ok(jd && jd.count === 2);
assert.equal(jd.subtotal, 148);
console.log('PASS ② 同一店铺 2 件 → 小计 ¥148.00、2 件');

/* ③ 删除一件 → 总计与店铺小计同步减少 */
const r3 = M.compute(items3.slice(0, 2));
assert.equal(r3.total, 138.9);
assert.equal(M.round2(r1.total - r3.total), 199);
assert.equal(r3.groups.some((g) => g.platform === 'pdd'), false);
console.log('PASS ③ 删除 AirPods → 总计 ¥337.90 → ¥138.90，拼多多分组消失');

/* ④ 不填价 → 空态，且不出现假的 ¥0 */
const r0 = M.compute([
  { q: '猫粮', offers: [{ platform: 'jd', price: '' }] },
  { q: '洗衣液', offers: [{ platform: 'jd', price: null }] },
]);
const empty = M.summaryHtml(r0, nameOf);
assert.equal(r0.total, null);
assert.equal(r0.pricedCount, 0);
assert.match(empty, /需要你填价格/);
assert.ok(!/¥\s*0(?:\.0+)?/.test(empty));
console.log('PASS ④ 未填价 → total=null，空态正确，且无 ¥0');

console.log('\nALL 4 ASSERTIONS PASSED');
