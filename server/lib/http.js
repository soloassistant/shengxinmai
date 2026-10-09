/* ==========================================================================
   省心买 · 服务端 · HTTP 小工具
   零依赖，用 Node 18+ 自带的全局 fetch。
   ========================================================================== */

'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带超时的 JSON 请求。
 * 联盟接口挂掉是常态，所以任何一次失败都不能把整个 /api/compare 拖死——
 * 调用方拿到 { ok:false } 后应该跳过这个平台，而不是抛出去。
 */
async function fetchJson(url, { timeout = 8000, method = 'GET', headers, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, signal: ctrl.signal, headers, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 有些平台出错时返回 HTML */ }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 这个结果值不值得重试？
 * 只有「网络层失败 / 5xx / 429」值得——同一个请求再发一次可能就好了。
 * 业务错误（签名错、参数错、商品不存在）重试一万次也不会变好，
 * 只会把配额和用户等待时间都翻倍，所以必须原样返回让上层立刻报错。
 */
function isRetriable(r) {
  if (!r) return false;
  if (r.json) return false;                                  // 拿到 JSON 就算成功
  return r.status === 0 || r.status >= 500 || r.status === 429;
}

/**
 * 有限次重试。
 * 退避用线性而不是指数：联盟网关的抖动通常在几十毫秒内恢复，
 * 指数退避会让用户白等 1s+，对交互式比价来说得不偿失。
 */
async function withRetry(fn, { retries = 1, backoffMs = 250 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    last = await fn(i);
    if (!isRetriable(last)) return last;
    if (i < retries) await sleep(backoffMs * (i + 1));
  }
  return last;
}

/** 带重试的 fetchJson —— 适配器统一用这个，不要直接用 fetchJson */
const fetchJsonRetry = (url, { retries = 1, backoffMs = 250, ...rest } = {}) =>
  withRetry(() => fetchJson(url, rest), { retries, backoffMs });

/** 从对象里按候选名依次取值——联盟接口字段名变动频繁，硬编码一个名字太脆 */
function pick(obj, candidates) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of candidates) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 价格统一成「元」。
 * 单位必须由调用方显式指定，不能靠数值大小去猜——
 * 拼多多用「分」，一件 100 元的商品是 10000 分，按大小猜会猜成 10000 元。
 */
function toYuan(v, unit) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return unit === 'fen' ? +(n / 100).toFixed(2) : n;
}

/**
 * 商品图地址归一化：把**协议相对**地址（`//img.alicdn.com/x.jpg`）补成 `https:`。
 *
 * 为什么必须在服务端补、而不是放宽前端的校验：
 * 前端 `safeImg()` 只认 `/^https?:\/\//i`，对 `//…` 一律返回空串 —— 那是**故意的**，
 * 并有一条断言钉着「协议相对的图片地址不渲染 <img>」（否则请求会打到别人的服务器上，
 * 等于把用户 IP 和 referer 送给第三方）。所以不能为了显示图片去放宽那个判据。
 * 而联盟接口（尤其淘宝系）回传的图片字段**常常就是 `//` 开头的**，
 * 于是「有图却永远只有占位块」—— 这个失败还是不报错的，只能靠这里补全。
 *
 * 只补「没有协议」这一种情况：`http://` / `https://` 原样保留（不擅自升级协议，
 * 那是上游的选择），其它（`javascript:`、`data:`、空）原样返回，交给前端判据去拒。
 */
function absoluteImage(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

/** 并发跑一组任务，单个失败不影响其他 */
async function settle(tasks) {
  return Promise.all(tasks.map((p) => Promise.resolve(p).catch((e) => ({ ok: false, error: String(e && e.message || e) }))));
}

module.exports = { fetchJson, fetchJsonRetry, withRetry, isRetriable, pick, toYuan, absoluteImage, settle, sleep };
