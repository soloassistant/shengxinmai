/* ==========================================================================
   省心买 · 适配器 · 大淘客（覆盖 淘宝 / 天猫）
   --------------------------------------------------------------------------
   接口：商品列表  https://openapi.dataoke.com/api/goods/get-goods-list
   文档：dataoke.com/kfpt/api-d.html
   主体：个人可注册

   验证状态：
     ✅ 签名算法 —— 两份互相独立的来源印证（官方验签文档 + 社区实现）
     ✅ 返回字段 —— 官方接口文档里有真实返回样例，解析层用该样例做了断言
     ⚠️ 请求参数名 —— 按公开文档整理（已由官方示例 URL 印证 appKey / version /
        pageId / pageSize 四个），首次接入请对照当前文档核对 keyWords / sort
   ========================================================================== */

'use strict';

const { signDataoke } = require('../lib/sign');
const { fetchJsonRetry, pick, toYuan, absoluteImage } = require('../lib/http');

const ENDPOINT = 'https://openapi.dataoke.com/api/goods/get-goods-list';
const VERSION  = 'v1.2.0';

/**
 * 从一条大淘客商品里抽出我们需要的字段。
 * 候选名给多个，是因为接口改过字段名；顺序 = 优先信任顺序。
 */
function normalizeOne(raw) {
  // 大淘客的价格单位是「元」
  const coupon = toYuan(pick(raw, ['couponPrice', 'couponAmount', 'coupon_value']), 'yuan') || 0;
  const actual = toYuan(pick(raw, ['actualPrice', 'actual_price', 'finalPrice']), 'yuan');
  const original = toYuan(pick(raw, ['originalPrice', 'original_price', 'price']), 'yuan');

  // 大淘客的 actualPrice 本身就是券后价；拿不到才自己减
  const price = original != null ? original : (actual != null ? actual + coupon : null);
  const final = actual != null ? actual : (price != null ? +(price - coupon).toFixed(2) : null);

  return {
    // sku 是商品在我们这边的身份。价格历史必须按它归并——
    // 按名字归并会被促销词（"限时秒杀"）拆成好几段历史。
    sku: String(pick(raw, ['goodsId', 'goods_id', 'itemId', 'item_id', 'id']) || ''),
    title: String(pick(raw, ['title', 'dtitle', 'goodsName', 'name']) || '').trim(),
    price,
    coupon,
    final,
    url: pick(raw, ['couponLink', 'itemLink', 'shortUrl', 'link', 'url']) || '',
    shop: pick(raw, ['shopName', 'sellerName', 'shop_name']) || '',
    sales: Number(pick(raw, ['monthSales', 'sales', 'volume']) || 0),
    /* ⚠ 键名必须是 `image`，不是 `img`（2026-10-09 修）。
       前端 `renderShopLive` 读的是 `it.image`，而这里以前回的是 `img` ——
       两边键名不一致，图片**永远取不到**，页面上只剩首字占位块，而且不报任何错。
       大淘客的真实字段名是 `pic_url`（原来那三个候选里没有它），一并补上。
       图片地址要过 `absoluteImage`：联盟常回 `//img…` 这种协议相对地址，
       而前端 `safeImg` 只认 `^https?://`（它是故意的，有断言钉着），不补就白拿。 */
    image: absoluteImage(pick(raw, ['pic_url', 'picUrl', 'mainPic', 'mainImage', 'imageUrl', 'img', 'pic']) || ''),
    commissionRate: pick(raw, ['commissionRate', 'commission_rate']) || null
  };
}

/** 接口返回可能是 data.list，也可能直接是 data 数组——两种都兜住 */
function extractList(body) {
  if (!body || typeof body !== 'object') return [];
  const d = body.data !== undefined ? body.data : body;
  if (Array.isArray(d)) return d;
  for (const k of ['list', 'goodsList', 'items', 'result']) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

module.exports = {
  id: 'dataoke',
  name: '淘宝 / 天猫',
  platform: '淘宝',
  envKeys: ['DATAOKE_APP_KEY', 'DATAOKE_APP_SECRET'],
  doc: 'https://www.dataoke.com/kfpt/api-d.html',
  note: '签名与解析已验证；请求参数名请对照当前文档核对',

  isConfigured(env) {
    return !!(env.DATAOKE_APP_KEY && env.DATAOKE_APP_SECRET);
  },

  async search(keyword, env, { pageSize = 20 } = {}) {
    const params = {
      appKey: env.DATAOKE_APP_KEY,
      version: VERSION,
      pageId: '1',
      pageSize: String(pageSize),
      keyWords: keyword,          // ← 如果接口报参数错误，先核对这一个
      sort: '0'
    };
    params.sign = signDataoke(params, env.DATAOKE_APP_SECRET);

    const qs = Object.keys(params)
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
      .join('&');

    const res = await fetchJsonRetry(ENDPOINT + '?' + qs, { timeout: 9000, retries: 1 });

    /* ⚠ 原写法是 `if (!res.ok && !res.json)`，而 `res.json` 是**对象**、
       恒为真值 ⇒ `!res.json` 永远是 false ⇒ **这个分支从来没执行过**。
       偏偏大淘客在密钥无效时返回的是 **HTTP 439**（非标准状态码）+
       `{"message":"appkey不存在.."}` —— **body 里没有 code 字段**，
       于是它既躲过了这个死分支，也躲过了下面按 `code !== 0` 判错的守卫，
       一路走到函数末尾被报成「该关键词没有推广商品」。
       把「密钥错了」说成「没有商品」是最容易被带偏的一类假结论：
       用户会以为关键词不对，而不是去看密钥。
       （439 与 message 的取值都是 2026-10-08 用假密钥实测的，不是推测。） */
    if (!res.ok) {
      const msg = (res.json && (res.json.msg || res.json.message)) || res.text || '无描述';
      const where = res.status === 0 ? '请求失败（网络层）' : `请求失败（HTTP ${res.status}）`;
      return { items: [], note: `${where}：${msg}` };
    }
    const body = res.json;
    if (!body) return { items: [], note: '返回不是 JSON：' + res.text };

    // 大淘客用 code=0 表示成功
    if (body.code !== undefined && Number(body.code) !== 0) {
      return { items: [], note: `接口返回 code=${body.code}：${body.msg || body.message || '无描述'}` };
    }

    // HTTP 200 但既没 code 也没列表 —— 壳变了，别静默当作"没有商品"
    if (body.code === undefined && extractList(body).length === 0) {
      return { items: [], note: '响应里既没有 code 也没有商品列表，响应壳可能变了', rawSample: Object.keys(body).slice(0, 20) };
    }

    const list = extractList(body);
    const items = list.map(normalizeOne).filter((x) => x.title && x.final != null);

    // 拿到数据但一条都没解析出来 —— 说明字段名对不上，把原始结构带回去，方便 5 秒修好
    if (!items.length && list.length) {
      return {
        items: [],
        note: '解析到 0 条，但接口返回了 ' + list.length + ' 条。字段名可能变了，原始字段如下：',
        rawSample: Object.keys(list[0]).slice(0, 40)
      };
    }
    return { items, note: items.length ? '' : '该关键词没有推广商品' };
  },

  _normalizeOne: normalizeOne,
  _extractList: extractList
};
