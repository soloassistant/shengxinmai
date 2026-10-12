/* ==========================================================================
   省心买 · 服务端 · 运行指标
   --------------------------------------------------------------------------
   上线后第一个问题永远是「现在到底怎么样」。
   日志回答"这一次发生了什么"，指标回答"整体趋势如何"，两者缺一不可。

   指标刻意保持少而准：
     · 请求数 / 错误数 / 被限流数 / 平均耗时
     · 每个平台的调用次数、成功率、平均耗时  ← 用来判断"哪个平台在拖后腿"
     · 每个接口的调用量                      ← 用来判断哪些能力真的有人用

   故意不做的事：直方图、分位数、采样、时序存储。
   那些需要真正的时序数据库，不是这个体量该背的东西——
   背了只会让运维成本变成没人看的数字。
   ========================================================================== */

'use strict';

function createMetrics({ startedAt = Date.now() } = {}) {
  let requests = 0, errors = 0, rateLimited = 0, totalMs = 0;
  const byPath = new Map();
  const byPlatform = new Map();

  function bump(map, key, init) {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
  }

  function request(path, status, ms) {
    requests++;
    totalMs += ms;
    if (status >= 500) errors++;
    const r = bump(byPath, path, () => ({ path, count: 0, errors: 0, totalMs: 0 }));
    r.count++;
    r.totalMs += ms;
    if (status >= 500) r.errors++;
  }

  function limited() { rateLimited++; }

  /** 一次平台调用。okFlag=false 也要计——失败率才是真正要看的东西 */
  function platform(id, okFlag, ms) {
    const p = bump(byPlatform, id, () => ({ id, calls: 0, ok: 0, fail: 0, totalMs: 0 }));
    p.calls++;
    p.totalMs += ms;
    if (okFlag) p.ok++; else p.fail++;
  }

  function snapshot(extra) {
    return {
      uptimeMs: Date.now() - startedAt,
      requests,
      errors,
      rateLimited,
      avgMs: requests ? Math.round(totalMs / requests) : 0,
      paths: [...byPath.values()]
        .map((r) => ({ ...r, avgMs: r.count ? Math.round(r.totalMs / r.count) : 0 }))
        .sort((a, b) => b.count - a.count),
      platforms: [...byPlatform.values()].map((p) => ({
        ...p,
        avgMs: p.calls ? Math.round(p.totalMs / p.calls) : 0,
        successRate: p.calls ? +(p.ok / p.calls).toFixed(4) : 0
      })),
      ...(extra || {})
    };
  }

  /* 对外投影：只保留前端「服务端统计」那一块真正消费的字段。
     ------------------------------------------------------------------
     `/api/metrics` 是**公开**端点，没有任何鉴权。而 snapshot() 原样带出去的东西里，
     抽屉一个都不用，却全是白送的情报：

       · `store.file`              部署内的绝对路径（/.data/prices.jsonl）
       · `rateLimit` `basketRateLimit`
                                   限流容量与补充速率 —— 攻击者据此能把 flood
                                   调到「刚好不被拒」，等于把闸门参数送出去
       · `cache`                   缓存规格与命中率，勾勒内部实现
       · `paths`                   逐路径调用量，还原流量结构与业务规模
       · `adapters`                哪几家配了密钥 —— 枚举攻击面
       · `uptimeMs`                精确到进程启动时刻，辅助指纹识别

     线上实测（2026-10-12）：/api/metrics 200、1118~1351 B，上面每一样都在。
     修法不是「给端点加锁」—— 前端要无鉴权地读它；而是**按消费面收窄产出**。
     判据：抽屉消费什么，这里就给什么，别的都不给。
     ------------------------------------------------------------------ */
  function snapshotPublic() {
    const s = snapshot();
    return {
      requests: s.requests,
      errors: s.errors,
      rateLimited: s.rateLimited,
      avgMs: s.avgMs,
      platforms: s.platforms
    };
  }

  function reset() {
    requests = 0; errors = 0; rateLimited = 0; totalMs = 0;
    byPath.clear(); byPlatform.clear();
  }

  return { request, limited, platform, snapshot, snapshotPublic, reset };
}

module.exports = { createMetrics };
