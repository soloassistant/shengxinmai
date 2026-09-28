/* ==========================================================================
   省心买 · 适配器 · 京东联盟
   --------------------------------------------------------------------------
   接口：jd.union.open.goods.query
   网关：https://api.jd.com/routerjson
   文档：union.jd.com/helpcenter/13246-13312-108188
   主体：个人可注册（需填推广渠道，高佣权限有等级门槛）

   验证状态：
     ✅ 签名算法 —— 官方文档给了拼接示例原文，测试里用该原文做了黄金断言
     ✅ 京东的业务参数必须整体塞进 360buy_param_json（紧凑 JSON，不能有空格）
     ⚠️ 返回结构 —— 按文档整理。注意京东的响应壳里 responce 是官方拼写错误，
        真实返回就是 "jd_union_open_goods_query_responce"，代码两种拼写都兜住
   ========================================================================== */

'use strict';

const { signJd } = require('../lib/sign');
const { fetchJsonRetry, pick, toYuan } = require('../lib/http');

const ENDPOINT = 'https://api.jd.com/routerjson';
const METHOD   = 'jd.union.open.goods.query';

/** 京东要求 yyyy-MM-dd HH:mm:ss，时区固定 GMT+8 —— 用本机时区会验签失败 */
function gmt8Stamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' '
       + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function normalizeOne(raw) {
  const priceInfo = raw.priceInfo || {};
  const couponInfo = raw.couponInfo || {};
  const couponList = Array.isArray(couponInfo.couponList) ? couponInfo.couponList : [];

  const price = toYuan(pick(priceInfo, ['lowestPrice', 'price']), 'yuan');
  // 京东会给一个已经算好的券后价，优先用它；没有才自己减
  let final = toYuan(pick(priceInfo, ['lowestCouponPrice', 'lowestPriceAfterCoupon']), 'yuan');
  const coupon = couponList.length
    ? toYuan(pick(couponList[0], ['discount', 'couponDiscount']), 'yuan') || 0
    : 0;
  if (final == null && price != null) final = +(price - coupon).toFixed(2);

  return {
    // 京东的商品身份 —— 价格历史按 skuId 归并，不按商品名
    sku: String(pick(raw, ['skuId', 'sku_id', 'wareId', 'ware_id', 'itemId', 'id']) || ''),
    title: String(pick(raw, ['skuName', 'title', 'goodsName']) || '').trim(),
    price,
    coupon,
    final,
    // materialUrl 是联盟推广链接，自带返佣归因
    url: pick(raw, ['materialUrl', 'itemUrl', 'url']) || '',
    shop: pick(raw.shopInfo || {}, ['shopName']) || '',
    sales: Number(pick(raw, ['inOrderCount30Days', 'comments', 'sales']) || 0),
    img: pick(raw, ['imageUrl', 'img', 'pic']) || '',
    commissionRate: pick(raw.commissionInfo || {}, ['commissionShare']) || null
  };
}

/** 京东把真正的结果又包了一层 JSON 字符串，得再解一次 */
function unwrap(body) {
  if (!body || typeof body !== 'object') return null;
  const shell = body['jd_union_open_goods_query_responce']
             || body['jd_union_open_goods_query_response'];
  if (!shell) return null;

  const inner = pick(shell, ['queryResult', 'result', 'getResult']);
  if (typeof inner === 'string') {
    try { return JSON.parse(inner); } catch { return null; }
  }
  return inner || null;
}

module.exports = {
  id: 'jd',
  name: '京东',
  platform: '京东',
  envKeys: ['JD_UNION_APP_KEY', 'JD_UNION_APP_SECRET'],
  doc: 'https://union.jd.com/helpcenter/13246-13312-108188',
  note: '签名已用官方示例验证；返回结构按文档整理',

  isConfigured(env) {
    return !!(env.JD_UNION_APP_KEY && env.JD_UNION_APP_SECRET);
  },

  async search(keyword, env, { pageSize = 20 } = {}) {
    const params = {
      method: METHOD,
      app_key: env.JD_UNION_APP_KEY,
      timestamp: gmt8Stamp(),
      format: 'json',
      v: '1.0',
      sign_method: 'md5',
      // 业务参数整体作为一个参数传，值必须是紧凑 JSON（不能带空格，否则签名不一致）
      '360buy_param_json': JSON.stringify({
        goodsReqDTO: { keyword, pageIndex: 1, pageSize }
      })
    };
    params.sign = signJd(params, env.JD_UNION_APP_SECRET);

    const qs = Object.keys(params)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&');

    const res = await fetchJsonRetry(ENDPOINT + '?' + qs, { timeout: 9000, retries: 1 });
    if (!res.ok && !res.json) return { items: [], note: `请求失败（HTTP ${res.status}）：${res.text}` };

    const body = res.json;
    if (!body) return { items: [], note: '返回不是 JSON：' + res.text };
    if (body.error_response) {
      const e = body.error_response;
      return { items: [], note: `网关报错 ${e.code || ''}：${e.zh_desc || e.msg || ''}` };
    }

    const payload = unwrap(body);
    if (!payload) {
      return { items: [], note: '没找到 jd_union_open_goods_query_responce 节点，响应壳可能变了', rawSample: Object.keys(body) };
    }
    if (Number(payload.code) !== 200) {
      return { items: [], note: `接口返回 code=${payload.code}：${payload.message || ''}` };
    }

    const list = Array.isArray(payload.data) ? payload.data : [];
    const items = list.map(normalizeOne).filter((x) => x.title && x.final != null);
    if (!items.length && list.length) {
      return { items: [], note: '解析到 0 条，但返回了 ' + list.length + ' 条，字段名可能变了', rawSample: Object.keys(list[0]) };
    }
    return { items, note: items.length ? '' : '该关键词没有推广商品' };
  },

  _normalizeOne: normalizeOne,
  _unwrap: unwrap,
  _gmt8Stamp: gmt8Stamp
};
