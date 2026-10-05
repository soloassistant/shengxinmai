#!/usr/bin/env node
/* ==========================================================================
   省心买 · 服务端（零依赖，Node 18+）
   --------------------------------------------------------------------------
   一个进程同时干三件事：
     1. 比价接口   /api/compare   —— 这是加服务端的唯一理由（密钥不能放前端）
     2. 增值接口   /api/basket 省钱清单、/api/history 价格历史
     3. 静态文件   —— 让整个应用单端口跑起来，可以直接部署

   工程上的底线（都是上线之后才会痛的东西）：
     · 每个请求一个 request-id，贯穿日志与响应头 —— 用户报错时能直接定位
     · 对外接口限流 —— 保护的是我们自己的联盟配额，不是"防攻击"这么抽象
     · 比价结果做 TTL 缓存 —— 省掉重复的第三方请求，也避免被判定异常流量
     · 单平台失败必须被隔离 —— 一个平台挂了不能让整张卡变成错误
     · 错误一律是 { ok:false, error:{ code, message } } —— 前端不用猜字符串

   启动：
     node server/server.js
     PORT=9000 LOG_LEVEL=debug node server/server.js

   环境变量：
     PORT               监听端口（部署平台会注入）
     LOG_LEVEL          debug | info | warn | error
     SXM_DATA_DIR       价格历史落盘目录（默认 <项目根>/.data）
     SXM_CACHE_TTL_MS   比价缓存时长，默认 60000
     SXM_RL_BURST       限流桶容量，默认 60
     SXM_RL_RATE        限流补速（个/秒），默认 1
     （各平台密钥见 /api/health 返回的 envKeys）
   ========================================================================== */

'use strict';

const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');

const { compare, status } = require('./adapters');
const flightAdapter = require('./adapters/ignav');
const log = require('./lib/logger');
const { createCache, normKey } = require('./lib/cache');
const { createRateLimiter } = require('./lib/ratelimit');
const { createMetrics } = require('./lib/metrics');
const { createStore, titleFingerprint } = require('./lib/store');
const { computeBasket, DEFAULT_THRESHOLD } = require('./lib/basket');
const { settle } = require('./lib/http');
const { loadEnvFile } = require('./lib/envfile');

/* 密钥装载：优先真实环境变量，其次 server/env.local.json（部署沙箱设不了 env，密钥随目录走）。
   必须在读取任何 process.env 之前执行。 */
loadEnvFile(path.join(__dirname, 'env.local.json'), process.env);

const PORT = Number(process.env.PORT) || 8787;
const ROOT = path.resolve(__dirname, '..');          // 项目根 = 静态文件根

/* 价格历史落在项目根的 .data 下。静态服务会拒绝任何以 . 开头的路径段，
   所以这个文件不会被公开下载到。要换位置就设 SXM_DATA_DIR。 */
const DATA_DIR   = process.env.SXM_DATA_DIR || path.join(ROOT, '.data');
const PRICE_FILE = path.join(DATA_DIR, 'prices.jsonl');

const CACHE_TTL = Number(process.env.SXM_CACHE_TTL_MS) || 60000;
const RL_BURST  = Number(process.env.SXM_RL_BURST) || 60;
const RL_RATE   = Number(process.env.SXM_RL_RATE) || 1;

const BASKET_MAX_ITEMS = 8;      // 一件商品 = 一组外部查询，8 件已经要打 24 次
const BASKET_MAX_LEN   = 40;     // 单个关键词长度上限

/* 没接机票接口时，返回给前端的「手动查」入口。
   注意：这里只有跳转链接，**没有任何价格数字** —— 拿不到真实价就不填空数。 */
const FLIGHT_PLATFORMS_FALLBACK = [
  { id: 'qunar', name: '去哪儿', abbr: '去', cls: 'pf-qunar', tag: '低价排序',
    desc: '聚合各家代理报价，适合先看价格下限' },
  { id: 'ctrip', name: '携程', abbr: '携', cls: 'pf-ctrip', tag: '航线最全',
    desc: '改签退票规则写得清楚' },
  { id: 'fliggy', name: '飞猪', abbr: '飞', cls: 'pf-fliggy', tag: '阿里系',
    desc: '阿里系票价与会员权益打通常用' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md'  : 'text/plain; charset=utf-8',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.png' : 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

/* ---------- 组件 ---------- */
const cache   = createCache({ ttl: CACHE_TTL, max: 500 });
const metrics = createMetrics();
const limiter = createRateLimiter({ capacity: RL_BURST, refillPerSec: RL_RATE });

/* 清单接口比单次比价贵得多（N 件商品 = N 组外部请求），
   所以给它一个更紧的独立桶，而不是共用 /api/compare 的额度。 */
const basketLimiter = createRateLimiter({ capacity: 12, refillPerSec: 0.2 });

let store;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store = createStore({ file: PRICE_FILE });
  store.ensureLoaded();
} catch (e) {
  // 只读文件系统 / 无权限都不该让服务起不来：历史是增值功能，比价才是主业
  log.warn('store.unavailable', { dir: DATA_DIR, err: String(e && e.message || e) });
  store = createStore({ file: null });
}

/* ---------- 响应工具 ---------- */
function json(res, code, obj, rid, extra = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...(rid ? { 'X-Request-Id': rid } : {}),
    ...extra
  });
  res.end(body);
}

const fail = (res, code, errCode, message, rid, extra) =>
  json(res, code, { ok: false, error: { code: errCode, message } }, rid, extra);

/**
 * 取客户端 IP。
 * 必须优先看 X-Forwarded-For：线上跑在反向代理后面，
 * 直接读 socket.remoteAddress 会拿到代理自己的地址，
 * 结果就是"全世界共用一个令牌桶"—— 一个人点几十下，所有人都被限流。
 * 这个坑在本地测不出来，上线当天才会爆。
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = path.resolve(ROOT, '.' + rel);

  // 目录穿越防护：解析后必须仍在 ROOT 内
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  /* 以 . 开头的路径段一律不对外（.data 价格历史、.wbapp 标记、.git 等）。
     这是隐私边界，不是洁癖：价格历史库被整包下载走，等于把数据资产送人。 */
  const segments = rel.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 一律 no-cache：Service Worker 和静态资源都要能被下一次发布刷新，
      // 但保留 304 协商，命中时不需要重传体积
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- 比价（缓存 + 历史采集 + 指标） ---------- */
async function getCompare(keyword, rid) {
  const key = 'cmp:' + normKey(keyword);
  const hit = cache.get(key);
  if (hit) {
    log.debug('compare.cacheHit', { rid, q: keyword });
    return { ...hit, cached: true };
  }

  const data = await compare(keyword, process.env, { pageSize: 20, keep: 8 });

  // 每个平台的调用结果都要进指标，否则"哪个平台在拖后腿"永远只是感觉
  data.platforms.forEach((x) => metrics.platform(x.id, !!x.ok, x.ms || 0));

  // 采集价格历史。这是我们唯一的历史价来源：只记真实看到的价，一次一条。
  const recorded = store.recordCompare(data);
  if (recorded) log.info('price.recorded', { rid, q: keyword, points: recorded });

  /* 把历史摘要挂到每个平台的「最低价」上。
     只挂 lowest 而不挂 items 全部：既避免前端 N+1 请求，也避免响应体膨胀。
     用户真正会盯的就是最低价那一条，其余等他点开再单独查。 */
  data.platforms.forEach((x) => {
    if (!x.ok || !x.lowest || x.lowest.final == null) return;
    const sku = x.lowest.sku || titleFingerprint(x.lowest.title);
    if (!sku) return;
    const h = store.history(x.id, sku);
    if (!h.found) return;
    x.lowest.history = {
      count: h.count,
      lowest: h.lowest,
      highest: h.highest,
      latest: h.latest,
      verdict: h.verdict,
      verdictText: h.verdictText,
      points: h.points.slice(-24)     // 曲线只画最近 24 个点：够看趋势，也不撑大响应
    };
  });

  data.cached = false;
  cache.set(key, data);
  return data;
}

/* ---------- 机票（按航线查，不走关键词） ----------
   为什么要单独一个函数：机票不是"关键词比价"，它的入参是
   出发地 / 目的地 / 日期，而且返回的是一张按价格排好序的航班表。
   塞进 /api/compare 会变成四不像。 */
async function getFlights(q, rid) {
  const key = 'flt:' + [q.from, q.to, q.date, q.returnDate || '', q.cabin || 'economy', q.market || 'CN']
    .join('|').toLowerCase();
  const hit = cache.get(key);
  if (hit) {
    log.debug('flights.cacheHit', { rid, from: q.from, to: q.to });
    return { ...hit, cached: true };
  }

  const adapter = flightAdapter;
  if (!adapter.isConfigured(process.env)) {
    // 没密钥就如实说，不给假价格 —— 前端据此退回「手动查」入口
    const data = {
      ok: true,
      configured: false,
      query: q,
      flights: [],
      note: '机票实时报价未接入。配置 IGNAV_API_KEY 后这里会返回按价格排好序的航班表。',
      platforms: FLIGHT_PLATFORMS_FALLBACK
    };
    cache.set(key, data);
    return { ...data, cached: false };
  }

  const r = await adapter.searchRoute(q, process.env);
  const data = {
    ok: true,
    configured: true,
    query: q,
    at: r.at || Date.now(),
    market: r.market || q.market || 'CN',
    count: (r.items || []).length,
    flights: r.items || [],
    note: r.note || '',
    unconfigured: !!r.unconfigured
  };
  metrics.platform(adapter.id, !r.note || !!r.items.length, 0);

  /* 没数据时不缓存 —— 缓存一个空结果会把"临时故障"钉死几分钟，
     用户重试也还是空的，看起来就像坏了。有数据才缓存。 */
  if (data.flights.length) cache.set(key, data);
  return data;
}

/* ---------- 路由 ---------- */
async function api(req, res, p, url, rid) {
  if (p === '/api/health') {
    /* 这份列表就是**「哪些数据源真的实现了」的唯一事实来源**。
       前端抽屉不再自己猜：出现在这里的 = 有 adapter（配了 key 就能用），
       不出现的 = 当前版本没实现（配了 key 也没用）。
       踩过的坑：机票适配器（ignav）早就实现了，却没进这个列表，
       于是抽屉把它按"未接入·配 key 即可"展示 —— 用户配了也用不上，
       因为前端压根不知道它其实已经可用。 */
    const list = status(process.env);
    const flight = {
      id: flightAdapter.id,
      name: flightAdapter.name,
      platform: flightAdapter.platform,
      doc: flightAdapter.doc,
      note: flightAdapter.note,
      envKeys: flightAdapter.envKeys,
      configured: flightAdapter.isConfigured(process.env),
      implemented: true
    };
    const all = list.concat([flight]);
    return json(res, 200, {
      ok: true,
      configuredCount: all.filter((x) => x.configured).length,
      adapters: all,
      limits: {
        compareCacheMs: CACHE_TTL,
        rateBurst: RL_BURST,
        ratePerSec: RL_RATE,
        basketMaxItems: BASKET_MAX_ITEMS,
        // 前端不用再自己兜底一个数 —— 兜底值一旦和这里不一致就会打架
        basketThreshold: DEFAULT_THRESHOLD
      }
    }, rid);
  }

  if (p === '/api/metrics') {
    return json(res, 200, {
      ok: true,
      ...metrics.snapshot({
        cache: cache.stats(),
        rateLimit: limiter.stats(),
        basketRateLimit: basketLimiter.stats(),
        store: store.stats(),
        adapters: status(process.env).map((a) => ({ id: a.id, configured: a.configured }))
      })
    }, rid);
  }

  /* 机票：按航线查，返回按价格升序排好的航班表。
     入参是 from/to/date 而不是关键词 —— 这是它和 /api/compare 的根本区别。 */
  if (p === '/api/flights') {
    const from = (url.searchParams.get('from') || '').trim();
    const to   = (url.searchParams.get('to')   || '').trim();
    const date = (url.searchParams.get('date') || '').trim();
    if (!from || !to) return fail(res, 400, 'MISSING_ROUTE', '缺少出发地或目的地（from / to）', rid);
    if (!date)        return fail(res, 400, 'MISSING_DATE', '缺少出发日期（date，格式 2026-10-20）', rid);
    // 三字码或城市名都收，但长度要卡死，避免被当成注入载体
    if (from.length > 24 || to.length > 24) {
      return fail(res, 400, 'ROUTE_TOO_LONG', '出发地 / 目的地太长了', rid);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return fail(res, 400, 'BAD_DATE_FORMAT', '日期格式应为 YYYY-MM-DD', rid);
    }
    const rt = (url.searchParams.get('return') || '').trim();
    if (rt && !/^\d{4}-\d{2}-\d{2}$/.test(rt)) {
      return fail(res, 400, 'BAD_DATE_FORMAT', '返程日期格式应为 YYYY-MM-DD', rid);
    }

    const data = await getFlights({
      from, to, date,
      returnDate: rt || null,
      cabin: (url.searchParams.get('cabin') || '').trim() || 'economy',
      market: (url.searchParams.get('market') || '').trim() || 'CN',
      adults: Number(url.searchParams.get('adults')) || 1
    }, rid);
    return json(res, 200, data, rid);
  }

  if (p === '/api/compare') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return fail(res, 400, 'MISSING_QUERY', '缺少 q 参数', rid);
    if (q.length > 60) return fail(res, 400, 'QUERY_TOO_LONG', '关键词太长（上限 60 字）', rid);

    const data = await getCompare(q, rid);
    return json(res, 200, { ok: true, ...data }, rid);
  }

  if (p === '/api/basket') {
    const raw = url.searchParams.getAll('q').map((s) => s.trim()).filter(Boolean);
    if (!raw.length) {
      return fail(res, 400, 'MISSING_QUERY', '至少要给一件商品：用 ?q= 传，可以重复多次', rid);
    }
    if (raw.length > BASKET_MAX_ITEMS) {
      return fail(res, 400, 'TOO_MANY_ITEMS',
        '一次最多 ' + BASKET_MAX_ITEMS + ' 件（每件都要打一轮平台接口，再多会又慢又容易被限流）', rid);
    }
    const tooLong = raw.find((s) => s.length > BASKET_MAX_LEN);
    if (tooLong) {
      return fail(res, 400, 'QUERY_TOO_LONG',
        '「' + tooLong.slice(0, 12) + '…」太长了，单件上限 ' + BASKET_MAX_LEN + ' 字', rid);
    }

    /* ⚠ 这里踩过一个很贵的坑（2026-10-05 定位到）：
       原来写的是 `Number(url.searchParams.get('th'))`。参数**没传**时
       get('th') 返回 null，而 Number(null) === 0 —— 于是 0 通过了
       `>= 0` 的校验，被当成用户显式指定了「门槛 0 元」，
       服务端自己的默认值 10 从此**一次都没生效**，卡片上一直显示「麻烦门槛 ¥0」。
       教训：把「参数缺失」和「参数是 0」分开判断，别让 Number() 把 null 抹成 0。
       —— 缺失 → NaN → undefined → 交给 computeBasket 用默认值。 */
    const thRaw = url.searchParams.get('th');
    const thParam = thRaw == null || thRaw === '' ? NaN : Number(thRaw);
    const saveThreshold = Number.isFinite(thParam) && thParam >= 0 ? thParam : undefined;

    const ckey = 'bsk:' + raw.map(normKey).join('|') + '|th' + (saveThreshold == null ? 'def' : saveThreshold);
    const hit = cache.get(ckey);
    if (hit) return json(res, 200, { ok: true, ...hit, cached: true }, rid);

    // 逐件比价，单件失败不影响其余 —— 清单里少一件，也比整单报错有用
    const settled = await settle(raw.map(async (q) => {
      try { return { q, data: await getCompare(q, rid) }; }
      catch (e) { return { q, error: String((e && e.message) || e) }; }
    }));

    // 先把平台显示名收齐，免得每件商品各带一份
    const names = {};
    settled.forEach((s) => {
      if (s && s.data) (s.data.platforms || []).forEach((pf) => { names[pf.id] = pf.name; });
    });

    const items = settled.map((s) => {
      const byPlatform = {};
      if (s && s.data) {
        (s.data.platforms || []).forEach((pf) => {
          if (!pf.ok || !pf.lowest || pf.lowest.final == null) return;
          byPlatform[pf.id] = pf.lowest.final;
        });
      }
      return { q: (s && s.q) || '?', byPlatform, names };
    });

    const result = computeBasket(items, saveThreshold == null ? {} : { saveThreshold });

    const firstOk = settled.find((s) => s && s.data);
    const out = {
      ...result,
      queries: raw,
      perQuery: settled.map((s) => {
        const prices = {};
        let best = null;
        if (s && s.data) {
          (s.data.platforms || []).forEach((pf) => {
            if (!pf.ok || !pf.lowest || pf.lowest.final == null) return;
            prices[pf.id] = pf.lowest.final;
            // 把最优那条的标题和链接一起带出去，前端才能给出可点的「打开」。
            // 不带的话前端只能显示价格，用户还得自己回主流程再搜一次。
            if (!best || pf.lowest.final < best.final) {
              best = {
                platform: pf.id, name: pf.name, final: pf.lowest.final,
                title: pf.lowest.title || '', url: pf.lowest.url || ''
              };
            }
          });
        }
        return { q: (s && s.q) || '?', prices, best, error: (s && s.error) || null };
      }),
      unconfigured: firstOk ? (firstOk.data.unconfigured || []) : [],
      failed: settled.filter((s) => !s || s.error).map((s) => ({ q: s && s.q, error: s && s.error })),
      cached: false
    };
    cache.set(ckey, out);
    return json(res, 200, { ok: true, ...out }, rid);
  }

  if (p === '/api/history') {
    const platform = (url.searchParams.get('platform') || '').trim();
    const sku = (url.searchParams.get('sku') || '').trim();
    if (!platform || !sku) {
      return fail(res, 400, 'MISSING_PARAM', '需要 platform 和 sku 两个参数', rid);
    }
    return json(res, 200, { ok: true, ...store.history(platform, sku) }, rid);
  }

  return fail(res, 404, 'NO_SUCH_ENDPOINT', '没有这个接口：' + p, rid);
}

/* ---------- 主服务 ---------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const rid = log.newRid();
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  res.setHeader('X-Request-Id', rid);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // 请求日志挂在 finish 上：拿到的是最终状态码，而不是我们以为的那个
  res.on('finish', () => {
    const ms = Date.now() - started;
    metrics.request(p, res.statusCode, ms);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode === 429 ? 'warn' : 'info';
    log[level]('http', { rid, method: req.method, path: p, status: res.statusCode, ms, ip: clientIp(req) });
  });

  try {
    if (p.startsWith('/api/')) {
      /* 接口只认 GET / HEAD。
         不加这条的话 POST /api/compare 也会被当成一次正常比价，
         白白消耗我们自己的联盟配额 —— 而这是最容易被人拿来刷的口子。 */
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return fail(res, 405, 'METHOD_NOT_ALLOWED', '接口只支持 GET', rid, { Allow: 'GET, HEAD' });
      }

      /* 限流只作用于 API，不碰静态资源。
         拦静态文件会让页面直接白屏 —— 那不是限流，那是自残。 */
      const rl = limiter.take(clientIp(req));
      if (!rl.allowed) {
        metrics.limited();
        log.warn('ratelimited', { rid, ip: clientIp(req), path: p });
        return fail(res, 429, 'RATE_LIMITED',
          '请求太频繁了，请 ' + rl.retryAfter + ' 秒后再试。', rid, { 'Retry-After': String(rl.retryAfter) });
      }

      if (p === '/api/basket') {
        const brl = basketLimiter.take(clientIp(req));
        if (!brl.allowed) {
          metrics.limited();
          return fail(res, 429, 'RATE_LIMITED',
            '省钱清单比较费额度，请 ' + brl.retryAfter + ' 秒后再试。', rid, { 'Retry-After': String(brl.retryAfter) });
        }
      }

      return await api(req, res, p, url, rid);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET', rid);
    }
    return serveStatic(req, res, p);
  } catch (e) {
    const msg = String((e && e.message) || e);
    log.error('unhandled', { rid, path: p, err: msg });
    if (res.headersSent) return;
    return fail(res, 500, 'INTERNAL', '服务内部错误，已记录（请求号 ' + rid + '）', rid);
  }
});

server.listen(PORT, () => {
  const list = status(process.env);
  const on = list.filter((x) => x.configured);

  process.stdout.write('\n  省心买 已启动\n');
  process.stdout.write('  http://localhost:' + PORT + '\n\n');
  process.stdout.write('  数据源：' + (on.length
    ? on.map((x) => x.name + '（已配置）').join('、')
    : '0 个已配置 —— 比价会走前端的手动比价模式') + '\n');

  list.filter((x) => !x.configured).forEach((x) => {
    process.stdout.write('    未配置 ' + x.name + '  需要 ' + x.envKeys.join(' / ') + '\n');
  });

  const s = store.stats();
  process.stdout.write('\n  接口：/api/compare  /api/basket  /api/history  /api/health  /api/metrics\n');
  process.stdout.write('  价格历史：' + (s.file || '（未落盘）') + '  已采 ' + s.points + ' 条 / ' + s.skus + ' 个商品\n');
  process.stdout.write('  限流：突发 ' + RL_BURST + ' 次、' + RL_RATE + ' 次每秒　缓存：' + (CACHE_TTL / 1000) + ' 秒\n\n');

  // 能不能真的落盘，启动时就要知道，而不是等用户比价完才发现没记住
  if (!s.file) log.warn('store.disabled', { reason: '落盘不可用，历史只在内存里，重启即失' });
});
