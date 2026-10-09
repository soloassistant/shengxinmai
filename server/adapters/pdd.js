/* ==========================================================================
   省心买 · 适配器 · 拼多多（多多进宝）
   --------------------------------------------------------------------------
   接口：pdd.ddk.goods.search
   网关：https://gw-api.pinduoduo.com/api/router
   文档：jinbao.pinduoduo.com（多多进宝开放平台）
   主体：个人可注册（四个平台里最宽松的一个）

   验证状态：
     ✅ 价格单位 —— 拼多多全用「分」，代码里显式按分换算（不靠数值大小猜）
     ✅ 签名结构 —— MD5(clientSecret + 拼接串 + clientSecret)，与京东同构
     ⚠️ 未经真实密钥端到端验证。首次调用若报签名错误，先核对 timestamp 是否为「秒」

   注意一个实现取舍：多多进宝的推广链接要另外调 pdd.ddk.goods.promotion.url.generate
   才能生成（会多一次请求）。这里先用公开的商品页链接，
   用户能正常打开下单，只是佣金归因要等接上转链接口才有。
   ========================================================================== */

'use strict';

const { signPdd } = require('../lib/sign');
const { fetchJson, withRetry, pick, toYuan, absoluteImage } = require('../lib/http');

const ENDPOINT = 'https://gw-api.pinduoduo.com/api/router';
const TYPE     = 'pdd.ddk.goods.search';

function normalizeOne(raw) {
  // 拼多多全部按「分」计价
  const groupPrice = toYuan(pick(raw, ['min_group_price', 'minGroupPrice']), 'fen');
  const normalPrice = toYuan(pick(raw, ['min_normal_price', 'minNormalPrice']), 'fen');
  const coupon = toYuan(pick(raw, ['coupon_discount', 'couponDiscount']), 'fen') || 0;

  const price = normalPrice != null ? normalPrice : groupPrice;
  const final = groupPrice != null ? +(groupPrice - coupon).toFixed(2) : null;

  const goodsId = pick(raw, ['goods_id', 'goodsId']);

  return {
    // 多多进宝的 goods_id 就是商品身份，价格历史按它归并
    sku: goodsId ? String(goodsId) : '',
    title: String(pick(raw, ['goods_name', 'goodsName', 'goods_desc']) || '').trim(),
    price,
    coupon,
    final,
    // 公开商品页链接：能正常打开下单，但不带返佣归因
    url: pick(raw, ['goods_url', 'url']) || (goodsId ? 'https://mobile.yangkeduo.com/goods.html?goods_id=' + goodsId : ''),
    shop: pick(raw, ['mall_name', 'mallName']) || '',
    // 拼多多这里给的是「1万+」这种文案而不是数字，能转就转
    sales: (() => {
      const tip = pick(raw, ['sales_tip', 'salesTip']);
      if (tip == null) return Number(pick(raw, ['sales']) || 0);
      const m = String(tip).match(/^([\d.]+)\s*(万)?/);
      return m ? Math.round(Number(m[1]) * (m[2] ? 10000 : 1)) : 0;
    })(),
    /* ⚠ 键名必须是 `image`（前端 `renderShopLive` 读的是 `it.image`），
       以前回的是 `img` —— 键名对不上，图片永远取不到且不报错（2026-10-09 修）。
       字段名本来是对的（`goods_thumbnail_url`），补的是协议相对地址那一环。 */
    image: absoluteImage(pick(raw, ['goods_thumbnail_url', 'goods_image_url', 'goodsImageUrl', 'goods_thumb_url']) || ''),
    commissionRate: pick(raw, ['promotion_rate', 'promotionRate']) || null
  };
}

module.exports = {
  id: 'pdd',
  name: '拼多多',
  platform: '拼多多',
  envKeys: ['PDD_CLIENT_ID', 'PDD_CLIENT_SECRET'],
  doc: 'https://jinbao.pinduoduo.com/',
  note: '价格单位与签名结构已确认；未经真实密钥端到端验证',

  isConfigured(env) {
    return !!(env.PDD_CLIENT_ID && env.PDD_CLIENT_SECRET);
  },

  async search(keyword, env, { pageSize = 20 } = {}) {
    const params = {
      type: TYPE,
      client_id: env.PDD_CLIENT_ID,
      timestamp: String(Math.floor(Date.now() / 1000)),   // 秒，不是毫秒
      data_type: 'JSON',
      version: 'v1.0',
      keyword,
      page: '1',
      page_size: String(pageSize),
      sort_type: '0'
    };
    params.sign = signPdd(params, env.PDD_CLIENT_SECRET);

    // 多多进宝网关收 POST + JSON body，参数（含 sign）全在 body 里。
    // 走 withRetry 而不是裸 fetch：网关偶尔抖一下（连接重置 / 502），重试一次通常就好；
    // 签名错这类业务错误不会被重试，避免让用户白等两次超时。
    const res = await withRetry(
      () => fetchJson(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        timeout: 9000
      }),
      { retries: 1 }
    );

    const status = res.status;
    const raw = res.text;
    const body = res.json;

    // status 0 = 根本没连上，得说"请求失败"而不是"返回不是 JSON"，否则排查时会被带偏
    if (status === 0) return { items: [], note: '请求失败：' + raw.slice(0, 300) };
    if (!body) return { items: [], note: `返回不是 JSON（HTTP ${status}）：` + raw.slice(0, 300) };
    if (body.error_response) {
      const e = body.error_response;
      return { items: [], note: `网关报错 ${e.error_code || ''}：${e.error_msg || ''}` };
    }

    const payload = body.goods_search_response || body.goodsSearchResponse;
    if (!payload) {
      return { items: [], note: '没找到 goods_search_response 节点，响应结构可能变了', rawSample: Object.keys(body) };
    }

    const list = Array.isArray(payload.goods_list) ? payload.goods_list : [];
    const items = list.map(normalizeOne).filter((x) => x.title && x.final != null);
    if (!items.length && list.length) {
      return { items: [], note: '解析到 0 条，但返回了 ' + list.length + ' 条，字段名可能变了', rawSample: Object.keys(list[0]) };
    }
    return { items, note: items.length ? '' : '该关键词没有推广商品' };
  },

  _normalizeOne: normalizeOne
};
