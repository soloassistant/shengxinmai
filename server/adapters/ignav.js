/* ==========================================================================
   省心买 · 适配器 · 机票实时报价（ignav）
   --------------------------------------------------------------------------
   接口：单程票价  POST https://ignav.com/api/fares/one-way
        往返票价  POST https://ignav.com/api/fares/round-trip
        机场查询  GET  https://ignav.com/api/airports?q=北京
   文档：https://ignav.com/docs
   主体：**个人可自助注册**（免费 1000 次请求，无需信用卡、无需企业资质）

   为什么要这个适配器：
     之前认为"机票接口只有企业能做"—— 那只对携程/去哪儿官方平台成立。
     聚合型 API（RapidAPI 一系，ignav 属此类）对个人开放，
     官方 markets 文档明确列出 CN → China → CNY，支持国内航线与人民币计价。

   验证状态：
     ✅ 端点与参数   —— 官方文档 + 独立 skill 文档两处一致
     ✅ 市场/币种    —— ignav.com/docs/markets 明确含 CN=China=CNY
     ✅ 响应字段     —— 官方 FAQ 与文档给出完整字段表（见下方 normalizeOne）
     ⚠️ 未用真实密钥端到端跑过 —— 首次接入请先用 /api/health 确认 configured=true
   ========================================================================== */

'use strict';

const { fetchJsonRetry, pick } = require('../lib/http');

const BASE = 'https://ignav.com';
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', HKD: 'HK$', GBP: '£' };

/** 把 ISO 时间戳 "2026-10-20T08:00:00" 切成 "08:00"（跨天加 +1） */
function hhmm(iso, dayOffset) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return m[1] + ':' + m[2] + (dayOffset ? ' (+1)' : '');
}

/**
 * 把一条 ignav itinerary 抽成界面要的扁平结构。
 * 字段名以官方文档为准；同时给出候选名兜底（接口改版时不至于全空）。
 */
function normalizeOne(raw, symbol) {
  if (!raw || typeof raw !== 'object') return null;
  const out = raw.outbound || {};
  const segs = Array.isArray(out.segments) ? out.segments : [];
  const first = segs[0] || {};
  const last  = segs[segs.length - 1] || {};

  const priceRaw = raw.price || {};
  const amount = Number(pick(priceRaw, ['amount', 'value', 'total']) ?? NaN);
  if (!isFinite(amount)) return null;

  const stopCount = Math.max(0, segs.length - 1);
  const carriers = [];
  segs.forEach((s) => {
    // 多航段可能换航司，全部收进来，界面才能写「A + B 承运」
    const c = pick(s, ['operating_carrier_name', 'marketing_carrier_name']);
    if (c && carriers.indexOf(c) === -1) carriers.push(c);
  });

  return {
    id: String(pick(raw, ['ignav_id', 'id']) || ''),
    price: amount,
    currency: pick(priceRaw, ['currency']) || 'CNY',
    symbol: symbol || '',
    cabin: pick(raw, ['cabin_class']) || '',
    carrier: carriers.join(' + ') || pick(first, ['marketing_carrier_name', 'operating_carrier_name']) || '—',
    code: pick(first, ['marketing_carrier_code']) || '',
    flightNo: pick(first, ['flight_number']) || '',
    stops: stopCount,
    // 「直飞 / 经停 N 站」—— 用户要一眼看出要不要中转
    stopsText: stopCount === 0 ? '直飞' : '经停 ' + stopCount + ' 站',
    depAirport: pick(first, ['departure_airport']) || '',
    arrAirport: pick(last,  ['arrival_airport'])   || '',
    depTime: hhmm(pick(first, ['departure_time_local']), false),
    arrTime: hhmm(pick(last,  ['arrival_time_local']),   false),
    durationMin: Number(pick(out, ['duration_minutes']) || 0),
    bags: raw.bags || null,
    selfTransfer: !!pick(raw, ['requires_self_transfer'])
  };
}

/** 从返回体里取出 itinerary 数组，兼容几种可能的包裹层 */
function extractList(body) {
  if (!body || typeof body !== 'object') return [];
  const d = body.data !== undefined ? body.data : body;
  if (Array.isArray(d)) return d;
  for (const k of ['itineraries', 'list', 'items', 'results']) {
    if (Array.isArray(d[k])) return d[k];
  }
  return [];
}

/** 分钟 → 「2小时15分」 */
function humanMin(min) {
  const m = Number(min) || 0;
  if (!m) return '';
  const h = Math.floor(m / 60), r = m % 60;
  return h ? h + '小时' + (r ? r + '分' : '') : r + '分';
}

/**
 * 按价格升序。
 * 单独抽成函数是为了**能被测试直接打到** —— 排序是这个功能的核心承诺
 * （"自动排序好"），如果它只在 searchRoute 内部悄悄做，测试只能自己
 * sort 一遍再断言，那验的就是测试自己的代码。变异实验会当场拆穿这点。
 */
function sortByPrice(items) {
  return (items || []).slice().sort((a, b) => (a.price || 0) - (b.price || 0));
}

module.exports = {
  id: 'ignav',
  name: '机票实时报价',
  platform: '机票',
  envKeys: ['IGNAV_API_KEY'],
  doc: 'https://ignav.com/docs',
  note: '个人可自助注册（免费 1000 次）；未用真实密钥端到端验证过',

  isConfigured(env) {
    return !!(env && env.IGNAV_API_KEY);
  },

  _normalizeOne: normalizeOne,
  _extractList: extractList,
  _humanMin: humanMin,
  sortByPrice: sortByPrice,

  /**
   * 查一条航线的票价，按价格升序返回。
   * @param {{from:string,to:string,date:string,returnDate?:string,market?:string}} q
   *   from/to 用 IATA 三字码（北京=BJS 或机场码 PEK/PKX）。
   */
  async searchRoute(q, env) {
    if (!this.isConfigured(env)) {
      return { items: [], note: '未配置 IGNAV_API_KEY —— 机票实时报价不可用', unconfigured: true };
    }
    const market = (q.market || 'CN').toUpperCase();
    const symbol = CURRENCY_SYMBOL[market === 'CN' ? 'CNY' : market] || '';
    const roundTrip = !!q.returnDate;
    const endpoint = BASE + (roundTrip ? '/api/fares/round-trip' : '/api/fares/one-way');
    const payload = {
      origin: q.from,
      destination: q.to,
      departure_date: q.date,
      adults: q.adults || 1,
      cabin_class: q.cabin || 'economy',
      market
    };
    if (roundTrip) payload.return_date = q.returnDate;

    const res = await fetchJsonRetry(endpoint, {
      method: 'POST',
      headers: { 'X-Api-Key': env.IGNAV_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 12000,
      retries: 1
    });

    /* ⚠ 原写法是 `if (!res.ok && !res.json)`，`res.json` 是**对象**、恒为真值
       ⇒ `!res.json` 永远 false ⇒ **这个分支从来没执行过**。
       而 ignav 密钥无效时返回的是 HTTP 401 + `{"error":{"code":"invalid_api_key"}}`：
       body 里有 json，于是它躲过这个死分支；`extractList` 又取不到 itineraries，
       最后一句话就被报成「这条航线当天没有查到报价（可能无航班或已售罄）」——
       **把「密钥错了」说成「没有航班」**。
       （401 与 error.code 的取值是 2026-10-08 用假密钥实测的。） */
    if (!res.ok) {
      const e = (res.json && res.json.error) || {};
      const msg = e.message || e.code || String(res.text || '').slice(0, 160) || '无描述';
      const where = res.status === 0 ? '请求失败（网络层）' : `请求失败（HTTP ${res.status}）`;
      return { items: [], note: `机票接口${where}：${msg}` };
    }
    const body = res.json;
    if (!body) return { items: [], note: '机票接口返回不是 JSON：' + String(res.text || '').slice(0, 160) };
    // HTTP 200 但带着 error 对象 —— 也不能当成"没有航班"
    if (body.error) {
      const e = body.error;
      return { items: [], note: `机票接口报错 ${e.code || ''}：${e.message || e.type || '无描述'}` };
    }

    const list = extractList(body);
    const items = sortByPrice(
      list.map((x) => normalizeOne(x, symbol)).filter(Boolean)
    );

    if (!items.length && list.length) {
      return {
        items: [],
        note: '解析到 0 条，但接口返回了 ' + list.length + ' 条。字段名可能变了，原始字段如下：',
        rawSample: Object.keys(list[0]).slice(0, 40)
      };
    }
    return {
      items,
      note: items.length ? '' : '这条航线当天没有查到报价（可能无航班或已售罄）',
      at: Date.now(),
      market
    };
  },

  /* 兼容 /api/compare 的通用 compare() —— 机票按「关键词」查不了，
     所以这里明确返回不可用，避免被当成商品关键词误调。 */
  async search(keyword) {
    return { items: [], note: '机票不走关键词比价，请用 /api/flights?from=&to=&date=' };
  }
};
