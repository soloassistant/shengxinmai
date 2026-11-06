/* 手填到手价清单：不联网、不编价，只做加法与分组。
   没有有效价格时 total 必须为 null，界面显示空态，不能出现 ¥0。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SXMManual = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  /* 按「分」四舍五入。Math.round(n * 100) / 100 对 1.005 会得到 1.00：
     1.005 * 100 在二进制里是 100.4999…；先收敛到 15 位有效数字再取整。 */
  const round2 = (n) => {
    const v = Number(n);
    if (!isFinite(v)) return v;
    const cents = (v < 0 ? -1 : 1) * Math.round(Number((Math.abs(v) * 100).toPrecision(15)));
    return cents / 100;
  };
  const money = (n) => '¥' + round2(n).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 单件到手价上限。存在的意义不是"防黑客"，而是别让一个粘贴进来的
     19 位数字把总账算成 999999999999999868928.00 —— 那个数字看起来像真的。 */
  const PRICE_MAX = 1000000;

  /**
   * 把用户填/粘贴的东西读成一个价格。
   * 结算页上复制下来通常是「¥1,299.00」「１２９９」这种，不是裸数字 ——
   * 直接 Number() 会得到 NaN，而 NaN 又被当成"没填"，界面就静默变回空态，
   * 用户完全不知道自己填的东西被丢了。所以先归一化，再判断。
   * 返回 { value, error }：value 为 null 时 error 一定有人话（空输入除外）。
   */
  function parsePrice(raw) {
    const s0 = String(raw == null ? '' : raw).trim();
    if (!s0) return { value: null, error: '' };
    const s = s0
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/．/g, '.')
      .replace(/[¥￥$，,\s]/g, '')
      .replace(/(元|块)$/, '');
    if (/^-/.test(s)) return { value: null, error: '到手价要大于 0' };
    if (!/^\d+(\.\d+)?$/.test(s)) return { value: null, error: '只填数字，比如 1299 或 1299.00' };
    const v = round2(Number(s));
    if (!isFinite(v) || v <= 0) return { value: null, error: '到手价要大于 0' };
    if (v > PRICE_MAX) return { value: null, error: '单件到手价不超过 ¥' + PRICE_MAX };
    return { value: v, error: '' };
  }

  function offersOf(item) {
    const by = new Map();
    ((item && item.offers) || []).forEach((o) => {
      const p = String((o && o.platform) || '').trim();
      const v = parsePrice(o && o.price).value;
      if (!p || !Number.isFinite(v) || v <= 0) return;
      const price = round2(v);
      if (by.get(p) == null || price < by.get(p)) by.set(p, price);
    });
    return [...by].map(([platform, price]) => ({ platform, price }));
  }

  function compute(items) {
    const list = (Array.isArray(items) ? items : []).filter((it) => it && String(it.q || '').trim());
    const detail = list.map((it) => {
      const offers = offersOf(it);
      const best = offers.slice().sort((a, b) => a.price - b.price)[0] || null;
      return { q: String(it.q), offers, best, subtotal: best ? best.price : null };
    });
    const priced = detail.filter((d) => d.best);
    const total = priced.length ? round2(priced.reduce((s, d) => s + d.subtotal, 0)) : null;

    const groups = [];
    priced.forEach((d) => {
      let g = groups.find((x) => x.platform === d.best.platform);
      if (!g) groups.push(g = { platform: d.best.platform, count: 0, subtotal: 0, items: [] });
      g.count += 1;
      g.subtotal = round2(g.subtotal + d.subtotal);
      g.items.push(d.q);
    });
    groups.sort((a, b) => b.subtotal - a.subtotal);

    // 贪心：每轮选覆盖最多未覆盖商品的店，并列取覆盖总价更低者。
    // 只回答「最少开几家」；合并后商品价可能变化，所以一律标估算。
    let merge = null;
    if (priced.length) {
      const platforms = new Set();
      priced.forEach((d) => d.offers.forEach((o) => platforms.add(o.platform)));
      const uncovered = new Set(priced.map((d) => d.q));
      const chosen = [];
      while (uncovered.size) {
        let pick = null, cover = [], cost = Infinity;
        platforms.forEach((p) => {
          const hit = priced.filter((d) => uncovered.has(d.q) && d.offers.some((o) => o.platform === p));
          if (!hit.length) return;
          const c = round2(hit.reduce((s, d) => s + d.offers.find((o) => o.platform === p).price, 0));
          if (hit.length > cover.length || (hit.length === cover.length && c < cost)) {
            pick = p; cover = hit; cost = c;
          }
        });
        if (!pick) break;
        chosen.push(pick);
        cover.forEach((d) => uncovered.delete(d.q));
      }
      const merged = round2(priced.reduce((s, d) => {
        const vals = d.offers.filter((o) => chosen.includes(o.platform)).map((o) => o.price);
        return s + (vals.length ? Math.min(...vals) : 0);
      }, 0));
      merge = {
        stores: chosen.length, total: merged,
        extraCost: round2(merged - total),
        appsSaved: Math.max(0, groups.length - chosen.length)
      };
    }

    return {
      items: detail, itemCount: list.length, pricedCount: priced.length,
      total, groups, merge, complete: priced.length > 0 && priced.length === list.length
    };
  }

  function itemBestText(best, nameOf) {
    return best ? money(best.price) + ' · ' + esc(nameOf(best.platform)) : '—';
  }

  function summaryHtml(res, nameOf) {
    if (!res || !res.pricedCount) {
      return '<div class="mb-empty">还没填价格，算不出总价。需要你填价格才有总价。</div>';
    }
    const lines = res.groups.map((g) =>
      `<div class="mb-line"><span>${esc(nameOf(g.platform))} · ${g.count} 件</span><b>${money(g.subtotal)}</b></div>`
    ).join('');
    const diff = res.merge ? res.merge.extraCost : 0;
    const amount = diff === 0 ? '持平' : (diff > 0 ? '多花 ' : '省 ') + money(Math.abs(diff));
    const mergeLine = res.merge
      ? `<div class="mb-line mb-merge"><span>合并到最少 ${res.merge.stores} 家 · 少开 ${res.merge.appsSaved} 个 App（估算）</span><b>${amount}</b></div>`
      : '';
    const missing = res.itemCount - res.pricedCount;
    return `<div class="mb-total"><span>合计 ${res.pricedCount} 件（清单共 ${res.itemCount} 件）</span><b>${money(res.total)}</b></div>` +
      (missing > 0 ? `<div class="mb-warn">还有 ${missing} 件没填价，下面的总价只含已填的 ${res.pricedCount} 件。</div>` : '') +
      `<div class="mb-groups">${lines}</div>${mergeLine}` +
      '<div class="mb-foot">按你填的「到手价」相加，不含运费、满减与优惠券；合并方案为估算，商品价可能变化。</div>';
  }

  return { compute, summaryHtml, itemBestText, money, round2, parsePrice, PRICE_MAX };
});
