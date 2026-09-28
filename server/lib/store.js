/* ==========================================================================
   省心买 · 服务端 · 价格历史
   --------------------------------------------------------------------------
   一条不能被绕过的原则：**我们只记录自己真实观察到的价格。**

   市面上任何一条历史价曲线都必须有来源。我们没有历史数据供应商，
   所以这个模块只做一件事：每成功比价一次，就把当时看到的到手价落一条。
   历史会随着使用自己长出来。

   样本不够的时候，接口会明说"还不够"，绝不画一条编出来的曲线去骗人 ——
   那等于把整个产品的可信度押在假数据上，而且是用户最容易发现的那种假。

   存储取舍：append-only JSONL 文件 + 进程内索引。
     · 为什么是文件：部署环境只有单端口 HTTP，没有数据库。
       文件在单实例下足够可靠，出问题能直接打开看，不需要额外的排查工具。
     · 为什么要有内存索引：不能让每次查询都全量扫文件。
       启动时读一次建索引，之后只追加。
     · 为什么按商品 ID 归并、而不是按商品名：名字会带促销词
       （"限时秒杀""【官方旗舰】"），同一个东西会被拆成好几段历史。
       ID 才是身份。接口没给 ID 时才退化成「标题指纹」，
       并且这一点会写在返回体里，不藏着。
     · 为什么落盘失败只吞不抛：比价本身是用户要的结果，
       历史记录是我们的内部账本。账本写不进去，不能连累用户看价格。

   保留策略：每个商品最多留 maxPointsPerSku 个点（默认 240），超了丢最旧的。
     不设「30 天过期」是因为价格有明显季节性——
     去年的双十一价对用户仍然有参考价值，过期反而是丢信息。
   ========================================================================== */

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * 标题指纹：接口没给商品 ID 时的兜底身份。
 * 先把【】（）这类促销前缀去掉再哈希，能明显减少
 * "同一件东西因为换了活动文案被拆成两段历史"。
 */
function titleFingerprint(title) {
  const cleaned = String(title || '')
    .replace(/[【\[（(][^】\]）)]*[】\]）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
  if (!cleaned) return '';
  return crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 16);
}

const keyOf = (platform, sku) => platform + ':' + sku;

/** 判定结论所需的最少样本数。低于它只能说"还不知道"，不许给结论。 */
const MIN_SAMPLES = 3;

/** 这段免责声明会跟着每一次历史查询返回 —— 它必须和数字一起被看到，不能只写在文档里 */
const NOTE =
  '这段历史只包含我们自己采集到的报价（每次真实比价记一条），不是平台全量历史价。'
  + '样本越攒越准，但永远不等于"这个商品一直以来的最低价"。';

function createStore({ file = null, maxPointsPerSku = 240 } = {}) {
  const idx = new Map();     // key -> { platform, sku, title, points: [{t, f}] }
  let loaded = false;
  let badLines = 0;
  let appended = 0;

  function pushPoint(platform, sku, title, final, t) {
    const k = keyOf(platform, sku);
    let e = idx.get(k);
    if (!e) { e = { platform, sku, title: title || '', points: [] }; idx.set(k, e); }
    if (title) e.title = title;

    const pts = e.points;
    const last = pts[pts.length - 1];
    // 同一时间戳、同一价格的重复写入不产生第二个点（重放 / 重试都会走到这里）
    if (last && last.t === t && last.f === final) return false;

    pts.push({ t, f: final });
    if (pts.length > maxPointsPerSku) pts.shift();
    return true;
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    let text;
    // 文件不存在是正常的（还没采到第一条）
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { badLines++; continue; }
      if (!rec || !rec.p || !rec.s || !Number.isFinite(Number(rec.f))) { badLines++; continue; }
      pushPoint(rec.p, rec.s, rec.n, Number(rec.f), Number(rec.t) || 0);
    }
  }

  /** 记录一个观测点。返回是否真的产生了新点。 */
  function recordOne({ platform, sku, title, final, at }) {
    /* 必须先确保索引已加载。
       否则"先 record 再 history"的顺序会把文件里已有的点再压一遍——
       ensureLoaded 会把刚 append 的内容当成新数据读回来，历史直接被放大一倍。
       这个 bug 在只测 record 或只测 history 时都看不出来。 */
    ensureLoaded();

    if (!platform) return false;
    const f = Number(final);
    if (!Number.isFinite(f) || f <= 0) return false;

    const id = sku || titleFingerprint(title);
    if (!id) return false;

    const t = at || Date.now();
    if (!pushPoint(platform, id, title, f, t)) return false;

    if (file) {
      const line = JSON.stringify({
        p: platform, s: id, n: String(title || '').slice(0, 120), f, t
      }) + '\n';
      // 落盘失败不能连累比价本身 —— 用户要的是价格，不是我们的账本
      try { fs.appendFileSync(file, line, 'utf8'); appended++; } catch { /* 忽略 */ }
    }
    return true;
  }

  /**
   * 把一次 /api/compare 的结果整体记下来。
   * 注意 platforms[].items 早已被截断到 keep 条（默认 8），
   * 所以这里额外把 lowest 也纳入 —— 最低价才是用户真正关心的那个点。
   */
  function recordCompare(data, at) {
    if (!data || !Array.isArray(data.platforms)) return 0;
    const t = at || data.at || Date.now();
    let n = 0;
    data.platforms.forEach((p) => {
      if (!p || !p.ok) return;
      const seen = new Set();
      const all = [];
      if (p.lowest) all.push(p.lowest);
      (p.items || []).forEach((it) => all.push(it));
      all.forEach((it) => {
        if (!it || it.final == null) return;
        const sku = it.sku || titleFingerprint(it.title);
        if (!sku || seen.has(sku)) return;
        seen.add(sku);
        if (recordOne({ platform: p.id, sku, title: it.title, final: it.final, at: t })) n++;
      });
    });
    return n;
  }

  /**
   * 查一个商品的历史。
   * 返回里的 verdict 只在样本够的时候才有结论；不够就是 insufficient + 说明。
   */
  function history(platform, sku) {
    ensureLoaded();
    const base = { platform, sku, basis: 'self-observed' };
    const e = idx.get(keyOf(platform, sku));

    if (!e || !e.points.length) {
      return {
        ...base, found: false, count: 0, points: [],
        verdict: 'unknown',
        verdictText: '还没采到这个商品的价格，攒不出历史。',
        note: NOTE
      };
    }

    const points = e.points;
    const finals = points.map((p) => p.f);
    const lowest = Math.min(...finals);
    const highest = Math.max(...finals);
    const latest = points[points.length - 1];

    let verdict = 'insufficient';
    let verdictText;

    if (points.length < MIN_SAMPLES) {
      verdictText = '只采到 ' + points.length + ' 次，还判断不了贵还是便宜'
        + '（至少 ' + MIN_SAMPLES + ' 次才给结论，免得拿一两个点就下结论）';
    } else if (latest.f <= lowest) {
      verdict = 'lowest';
      verdictText = '这是采集以来的最低价';
    } else if (latest.f >= highest) {
      verdict = 'highest';
      verdictText = '这是采集以来的最高价，可以再等等';
    } else {
      const over = (latest.f - lowest) / lowest;
      if (over <= 0.02) {
        verdict = 'near-lowest';
        verdictText = '已接近采集以来的最低价（高 ' + (over * 100).toFixed(1) + '%）';
      } else {
        const pos = (latest.f - lowest) / Math.max(1e-6, highest - lowest);
        verdict = 'mid';
        verdictText = '处在采集区间的 '
          + Math.round(pos * 100) + '% 位置，离最低价还差 ¥'
          + (latest.f - lowest).toFixed(2);
      }
    }

    return {
      ...base,
      found: true,
      title: e.title || '',
      count: points.length,
      points,
      lowest,
      highest,
      latest,
      firstSeen: points[0].t,
      lastSeen: latest.t,
      spanMs: latest.t - points[0].t,
      verdict,
      verdictText,
      note: NOTE
    };
  }

  function stats() {
    ensureLoaded();
    let points = 0;
    idx.forEach((e) => { points += e.points.length; });
    return { skus: idx.size, points, appended, badLines, maxPointsPerSku, file };
  }

  return {
    recordOne, recordCompare, history, stats,
    ensureLoaded,
    has: (platform, sku) => { ensureLoaded(); return idx.has(keyOf(platform, sku)); },
    clear: () => { idx.clear(); loaded = true; badLines = 0; appended = 0; }
  };
}

module.exports = { createStore, titleFingerprint, MIN_SAMPLES, NOTE };

