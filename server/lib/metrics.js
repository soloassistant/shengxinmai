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

  function reset() {
    requests = 0; errors = 0; rateLimited = 0; totalMs = 0;
    byPath.clear(); byPlatform.clear();
  }

  return { request, limited, platform, snapshot, reset };
}

module.exports = { createMetrics };
