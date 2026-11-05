/* 手填到手价清单：不联网、不编价，只做加法与分组。
   没有有效价格时 total 必须为 null，界面显示空态，不能出现 ¥0。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SXMManual = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => '¥' + Number(n).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function offersOf(item) {
    const by = new Map();
    ((item && item.offers) || []).forEach((o) => {
      const p = String((o && o.platform) || '').trim();
      const v = Number(o && o.price);
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
      '<div class="mb-foot">按你填的「到手价」相加，不含运费；合并方案为估算，商品价可能变化。</div>';
  }

  return { compute, summaryHtml, itemBestText, money, round2 };
});
