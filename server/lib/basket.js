/* ==========================================================================
   省心买 · 服务端 · 省钱清单算法
   --------------------------------------------------------------------------
   这是相对"比价列表"的真正升级点。

   现有比价工具把价格横着摆一排就结束了，把决策留给了用户。
   但用户真正的处境是：**要买好几样东西，且不想装一堆 App。**
   于是真正需要回答的问题不是"哪家最便宜"，而是：

     「我这份清单，是分几家买省钱，还是一家买齐省事？差价值不值得我折腾？」

   这个模块就回答这一个问题。它是纯函数——不联网、不读时间、不碰全局状态，
   所以可以用穷举的方式把它测透，而不是靠"看起来对"。

   两个方案：
     split  分件买最优 —— 每件各自挑最便宜的平台。总价最低，但要开 N 个 App。
     single 一家买齐   —— 选一个能覆盖整单的平台一次买完。只开 1 个 App，但可能贵。

   取舍阈值（默认 ¥10）：
     这是**产品决策，不是技术正确性**。为省 3 块钱去多装两个 App、
     多填两次地址，多数人不会干。所以阈值放在参数里，可以按人群调，
     而不是硬编一个"更聪明"的算法假装自己是客观的。
   ========================================================================== */

'use strict';

const round2 = (n) => Math.round(n * 100) / 100;

/* 「麻烦门槛」默认 10 元：省下的钱低于它，就建议用户图省事别折腾。
   2026-10-05 之前这里写死成 `opts.saveThreshold == null ? 10 : ...`，
   但服务端调用点把「没传 th 参数」错误地转成了 0（Number(null) === 0），
   于是这个默认值**从未生效**，卡片上一直显示「麻烦门槛 ¥0」。
   现在把默认值提出来做**唯一来源**，/api/health 也报它 —— 一处改全处对。 */
const DEFAULT_THRESHOLD = 10;

/**
 * @param {Array} items 每件商品在各平台的最低价
 *   [{ q:'猫粮', byPlatform:{ jd:89, pdd:79 }, names:{ jd:'京东', pdd:'拼多多' } }]
 * @param {Object} opts
 *   saveThreshold 低于这个金额就建议"一家买齐"（默认 10 元）
 * @returns {Object} 两个方案 + 一句能直接展示给人看的建议
 */
function computeBasket(items, opts = {}) {
  const threshold = opts.saveThreshold == null ? DEFAULT_THRESHOLD : Number(opts.saveThreshold);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];

  /* ---- 1. 逐件商品找最优 ---- */
  const unpriced = [];    // 一个平台都没给到价 —— 必须让用户知道，而不是悄悄不计入总价

  const detail = list.map((it) => {
    const by = it.byPlatform && typeof it.byPlatform === 'object' ? it.byPlatform : {};
    const names = it.names || {};
    const ranked = Object.keys(by)
      .filter((p) => by[p] != null && Number.isFinite(Number(by[p])))
      .map((p) => ({ platform: p, name: names[p] || p, final: round2(Number(by[p])) }))
      .sort((a, b) => a.final - b.final);

    if (!ranked.length) {
      unpriced.push({ q: it.q });
      return {
        q: it.q, best: null, alternatives: [], spread: 0,
        platformCount: 0, runnerUp: null, gapToRunnerUp: 0
      };
    }

    const best = ranked[0];
    const highest = ranked[ranked.length - 1].final;
    const runnerUp = ranked[1] || null;

    /* runnerUp / gapToRunnerUp 必须放在**返回给前端的结构**里。
       只塞进内部变量的话，前端就得自己重算一遍——
       同一套规则算两遍，迟早会不一致。 */
    return {
      q: it.q,
      best: { platform: best.platform, name: best.name, final: best.final },
      alternatives: ranked.slice(1),
      spread: round2(highest - best.final),
      platformCount: ranked.length,
      runnerUp: runnerUp
        ? { platform: runnerUp.platform, name: runnerUp.name, final: runnerUp.final }
        : null,
      gapToRunnerUp: runnerUp ? round2(runnerUp.final - best.final) : 0
    };
  });

  const priced = detail.filter((d) => d.best);

  /* ---- 2. 方案 A：分件买最优 ---- */
  const splitTotal = round2(priced.reduce((s, it) => s + it.best.final, 0));

  const splitMap = new Map();
  priced.forEach((it) => {
    const k = it.best.platform;
    const e = splitMap.get(k) || { platform: k, name: it.best.name, subtotal: 0, count: 0 };
    e.subtotal = round2(e.subtotal + it.best.final);
    e.count++;
    splitMap.set(k, e);
  });
  const splitPlatforms = [...splitMap.values()].sort((a, b) => b.subtotal - a.subtotal);

  /* ---- 3. 方案 B：一家买齐 ---- */
  const platformIds = new Set();
  list.forEach((it) => {
    const by = it.byPlatform || {};
    Object.keys(by).forEach((p) => { if (by[p] != null) platformIds.add(p); });
  });

  const singles = [];
  platformIds.forEach((pid) => {
    const missing = [];
    let total = 0;
    list.forEach((it) => {
      const by = it.byPlatform || {};
      const v = by[pid];
      if (v == null || !Number.isFinite(Number(v))) missing.push(it.q);
      else total = round2(total + round2(Number(v)));
    });
    // 只有能覆盖整单的平台才算"一家买齐"。缺件的方案不是方案，是残次品。
    if (!missing.length && list.length) {
      singles.push({ platform: pid, name: (it0(list, pid) || pid), total, count: list.length, missing: [] });
    }
  });
  singles.sort((a, b) => a.total - b.total);

  const bestSingle = singles[0] || null;
  const worstSingle = singles.length ? singles[singles.length - 1] : null;

  /* ---- 4. 给建议 ---- */
  const savingVsBestSingle = bestSingle ? round2(bestSingle.total - splitTotal) : null;
  const savingVsWorstSingle = worstSingle ? round2(worstSingle.total - splitTotal) : null;
  const appsSaved = Math.max(0, splitPlatforms.length - 1);

  let recommend, reason;

  if (!priced.length) {
    recommend = 'none';
    reason = '这一单里没有任何一件拿到价格，给不出方案。先确认关键词，或者等平台把密钥配上。';
  } else if (unpriced.length) {
    recommend = 'split';
    reason = '有 ' + unpriced.length + ' 件没拿到价格（'
      + unpriced.map((x) => '「' + x.q + '」').join('、')
      + '），下面两个方案都只算了拿到价的那 ' + priced.length + ' 件，不能当整单总价看。';
  } else if (!bestSingle) {
    recommend = 'split';
    reason = '没有哪个平台能一次买齐清单里的全部商品，只能分着买。'
      + '要开 ' + splitPlatforms.length + ' 个 App。';
  } else if (priced.length === 1) {
    recommend = 'single';
    reason = '只有一件商品，去「' + bestSingle.name + '」买就行。';
  } else if (appsSaved === 0) {
    /* 所有商品的最低价本来就落在同一家。
       这时候不该说"少开 0 个 App"——那句话是错的，用户一家都不用多开。
       文案必须跟着事实走，否则用户会开始怀疑其他数字。 */
    recommend = 'single';
    reason = '清单里每件商品的最低价都在「' + bestSingle.name
      + '」这一家，不用挑平台，直接去这家买齐就行。';
  } else if (savingVsBestSingle <= threshold) {
    recommend = 'single';
    reason = '一家买齐只贵 ¥' + savingVsBestSingle.toFixed(2)
      + '，但能少开 ' + appsSaved + ' 个 App。'
      + '省事比省这几块钱更值 —— 想省钱就自己分着买，差额就在这个数上。';
  } else {
    recommend = 'split';
    reason = '分件买能省 ¥' + savingVsBestSingle.toFixed(2)
      + '，超过 ¥' + threshold + ' 的"麻烦门槛"，值得多开 ' + appsSaved + ' 个 App。';
  }

  return {
    itemCount: list.length,
    pricedCount: priced.length,
    items: detail,
    unpriced,
    split: {
      total: splitTotal,
      platformCount: splitPlatforms.length,
      platforms: splitPlatforms
    },
    singles,
    bestSingle,
    worstSingle,
    savingVsBestSingle,
    savingVsWorstSingle,
    appsSaved,
    recommend,
    reason,
    threshold,
    currency: 'CNY',
    notes: buildNotes(priced.length, threshold, savingVsWorstSingle)
  };
}

/** 平台显示名（从任意一件商品的 names 里取即可） */
function it0(list, pid) {
  for (const it of list) {
    if (it.names && it.names[pid]) return it.names[pid];
  }
  return pid;
}

function buildNotes(pricedCount, threshold, savingVsWorstSingle) {
  const notes = [];
  if (pricedCount > 1) {
    notes.push('总价按各平台「最低到手价」相加，不含运费；合并下单时运费可能把它们再拉平一次。');
  }
  if (savingVsWorstSingle != null && savingVsWorstSingle > 0) {
    notes.push('"最贵的买齐方案"和"最低的分件方案"之间的差 ¥'
      + savingVsWorstSingle.toFixed(2) + '，就是这个清单理论上能省下的上限。');
  }
  notes.push('麻烦门槛 ¥' + threshold + ' 是我们的默认设定：低于它我们建议你图省事，高于它我们建议你折腾。');
  return notes;
}

module.exports = { computeBasket, round2, DEFAULT_THRESHOLD };
