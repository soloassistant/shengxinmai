/* ==========================================================================
   省心买 · 服务端 · 令牌桶限流
   --------------------------------------------------------------------------
   为什么上线必须有它：
     /api/compare 会拿着**我们的密钥和配额**对外发 3 个真实请求。
     公开在线的接口不限流，别人写个循环就能把配额烧光，
     更糟的是让联盟把我们判定成异常流量，直接连累所有用户。

   实现取舍：**单实例内存桶，故意不假装分布式。**
     部署环境没有 Redis。写一个"看起来分布式其实不是"的限流比不限流更危险，
     因为它会让人误以为多实例下也安全。这件事写在注释里，不藏在代码里。
     真要多实例限流，得上共享存储——那是换架构，不是改这个文件。

   桶按 IP 分。容量给得比"人手点"宽松（默认 60 次突发），
   因为正常用户连续点几下不该被拦；被拦的只应该是脚本。
   ========================================================================== */

'use strict';

function createRateLimiter({
  capacity = 60,          // 桶容量 = 允许的瞬时突发次数
  refillPerSec = 1,       // 每秒补多少令牌 = 长期平均速率
  maxKeys = 5000,         // 桶数量硬上限，防随机 IP 把内存刷爆
  now = () => Date.now()
} = {}) {
  const buckets = new Map();
  let rejected = 0;

  /** 清掉长期不活跃的桶。没有这一步，被随机的源 IP 刷一遍就是内存泄漏。 */
  function sweep(t) {
    const idleBefore = t - 10 * 60 * 1000;
    for (const [k, b] of buckets) {
      if (b.last < idleBefore) buckets.delete(k);
    }
  }

  function take(key) {
    const t = now();
    let b = buckets.get(key);

    if (!b) {
      if (buckets.size >= maxKeys) {
        sweep(t);
        // sweep 之后还是满的，就丢最久没动的，保证内存有硬上限
        while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      }
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }

    // 按流逝的时间补令牌，上限是桶容量（不攒无限多的额度）
    const elapsed = Math.max(0, (t - b.last) / 1000);
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = t;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfter: 0 };
    }

    rejected++;
    // 还差多少令牌，就还需要等多少秒 —— 这个数字要如实回给用户，不能只说"太频繁"
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec))
    };
  }

  function stats() {
    return { buckets: buckets.size, maxKeys, capacity, refillPerSec, rejected };
  }

  function reset() { buckets.clear(); rejected = 0; }

  return { take, stats, reset, sweep, get size() { return buckets.size; } };
}

module.exports = { createRateLimiter };
