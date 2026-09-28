/* ==========================================================================
   省心买 · 服务端 · TTL 缓存
   --------------------------------------------------------------------------
   为什么要它（不只是为了"快"）：
     1. 各平台联盟接口都有 QPS 限制。同一个关键词被反复问，会把自己问进黑名单；
     2. 一次 /api/compare 会并发打 3 个平台，缓存能直接省掉 2/3 的外部请求；
     3. 省钱清单会对 N 件商品各比一次，其中重复词很容易撞上——
        没有缓存的话，清单功能会把配额成倍烧掉。
     命中的响应会带 cached:true，让前端和日志都能看出来，不搞"看不见的魔法"。

   实现取舍：进程内存 + LRU 淘汰，**故意不做持久化**。
     价格是会变的，把过期价格持久化下来比不带缓存更危险：
     重启后拿着一小时前的价格当实时价，用户会照着错的价格做决定。
   ========================================================================== */

'use strict';

function createCache({ ttl = 60000, max = 500 } = {}) {
  const map = new Map();          // Map 的迭代顺序 = 插入顺序，正好用来做 LRU
  let hits = 0, misses = 0, evictions = 0;

  function get(key, now = Date.now()) {
    const e = map.get(key);
    if (!e) { misses++; return null; }
    if (e.exp <= now) { map.delete(key); misses++; return null; }
    map.delete(key);              // 命中后挪到队尾 = 最不容易被淘汰
    map.set(key, e);
    hits++;
    return e.value;
  }

  function set(key, value, now = Date.now()) {
    if (map.has(key)) map.delete(key);
    while (map.size >= max) { map.delete(map.keys().next().value); evictions++; }
    map.set(key, { value, exp: now + ttl, at: now });
    return value;
  }

  /** 命中率必须能被 /api/metrics 看到，否则"我加了缓存"这件事无法被证明 */
  function stats() {
    const total = hits + misses;
    return {
      size: map.size, max, ttlMs: ttl,
      hits, misses, evictions,
      hitRate: total ? +(hits / total).toFixed(4) : 0
    };
  }

  function clear() { map.clear(); hits = 0; misses = 0; evictions = 0; }

  return { get, set, stats, clear, get size() { return map.size; } };
}

/**
 * 缓存键归一化：大小写、首尾空白、连续空格都不该产生两个缓存条目。
 * 不做这一步的话，"AirPods Pro" 和 "airpods  pro" 会各占一份配额。
 */
function normKey(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = { createCache, normKey };
