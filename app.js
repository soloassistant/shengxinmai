/* ==========================================================================
   省心买 · 交互与解析层
   --------------------------------------------------------------------------
   这里做三件事：
     1. 把一句中文解析成 {场景, 参数}      —— 纯本地规则，不花钱、不联网、可离线
     2. 按场景渲染结果卡                     —— 数据从 data.js 取
     3. 管住「没有密钥时怎么办」              —— 降级为手动比价，而不是假装有价格
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     0. 小工具
     ====================================================================== */
  const $  = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const enc = encodeURIComponent;
  const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

  /* 演示模式开关：默认关闭。开着时会显示一串样例价格，
     卡片上必须同时打出「演示数据 · 非实时」，不允许静默伪装成真实报价。 */
  let DEMO_MODE = false;

  /* ======================================================================
     0.5 主题：跟随系统 / 浅色 / 深色
     ----------------------------------------------------------------------
     为什么是三态而不是一个开关：
       「跟随系统」才是大多数人的真实需求。把它砍掉逼用户在明暗里二选一，
       等于把自己的审美强加给别人。手动两档留给少数场景（投屏、截图、白天户外）。
     首帧渲染由 index.html 里的内联脚本负责，这里只管切换和"跟随系统变化"。
     没有 DOM 的环境（测试桩）不能抛异常，所以所有 DOM 操作都带兜底。
     ====================================================================== */
  const THEME_KEY   = 'sxm.theme';
  const THEMES      = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '自动', light: '浅色', dark: '深色' };
  let THEME = 'auto';

  const mql = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function isDarkNow() {
    if (THEME === 'dark') return true;
    if (THEME === 'light') return false;
    return !!(mql && mql.matches);
  }

  function applyTheme() {
    const dark = isDarkNow();
    try {
      const root = document.documentElement;
      if (root && root.setAttribute) root.setAttribute('data-theme', dark ? 'dark' : 'light');
      const tc = document.getElementById && document.getElementById('theme-color');
      if (tc && tc.setAttribute) tc.setAttribute('content', dark ? '#0E1116' : '#F5F6F8');
    } catch { /* 无 DOM 环境忽略 */ }
    const btn = $('#btn-theme');
    if (btn) btn.textContent = '主题：' + THEME_LABEL[THEME];
  }

  function setTheme(v) {
    THEME = THEMES.indexOf(v) >= 0 ? v : 'auto';
    try { localStorage.setItem(THEME_KEY, THEME); } catch { /* 存不上就本次生效 */ }
    applyTheme();
    renderDrawer();
  }

  function cycleTheme() {
    setTheme(THEMES[(THEMES.indexOf(THEME) + 1) % THEMES.length]);
  }

  /* ======================================================================
     1. 日期解析
     ====================================================================== */
  function baseToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function fmtISO(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtHuman(d) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK_CN[d.getDay()];
  }
  /**
   * 跨年时把年份写出来：「2027年1月5日 周二」。
   * 只写「1月5日 周二」的话，用户会默认它是自己刚过去那个 1 月（已过期），
   * 而它其实是明年的 —— 这种模糊会让整张出行卡的可信度打折。
   * 同一年内不长，避免每张卡都挂个"2026年"显得啰嗦。
   */
  function fmtHumanY(d, base) {
    const b = base || baseToday();
    const prefix = d.getFullYear() !== b.getFullYear() ? d.getFullYear() + '年' : '';
    return prefix + fmtHuman(d);
  }
  /** 时间戳 →「18:35」。用于标注价格是什么时候查的（价格按小时在变）。 */
  function fmtClock(ts) {
    const d = new Date(Number(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 从一句话里抠日期。
   * 支持：今天/明天/后天/大后天、周X/星期X/礼拜X、下周X、9月30日、9-30、9/30
   * 抠不到返回 null，由调用方决定是「默认明天」还是「反问用户」。
   */
  function parseDate(text) {
    const base = baseToday();

    // 绝对日期：9月30日 / 9月30号 / 9-30 / 9/30 / 09.30
    const abs = text.match(/(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/);
    if (abs) {
      const mo = +abs[1], da = +abs[2];
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        let d = new Date(base.getFullYear(), mo - 1, da);
        /* 2月30日这种不存在的日子，JS 不报错，直接滚到下一个月。
           实测卡片上写着「3月2日 周二」还标着「按你说的」——可用户说的
           明明是 2月30日。悄悄把日期换掉比报错更糟：人可能照着这天的票去安排行程。
           所以标记 invalid，交给上层明说"这一天不存在"。 */
        if (d.getMonth() !== mo - 1 || d.getDate() !== da) {
          return { date: null, label: mo + '月' + da + '日', explicit: true, invalid: true };
        }
        if (d.getTime() < base.getTime()) d = new Date(base.getFullYear() + 1, mo - 1, da);
        return { date: d, label: fmtHumanY(d), explicit: true };
      }
    }

    if (/大后天/.test(text)) { const d = addDays(base, 3); return { date: d, label: fmtHumanY(d), explicit: true }; }
    if (/后天/.test(text))   { const d = addDays(base, 2); return { date: d, label: fmtHumanY(d), explicit: true }; }
    if (/明天|明日|明儿/.test(text)) { const d = addDays(base, 1); return { date: d, label: fmtHumanY(d), explicit: true }; }
    if (/今天|今日|今晚|今儿/.test(text)) { return { date: base, label: fmtHumanY(base) + '（今天）', explicit: true }; }

    const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
    const thisMon = addDays(base, -(((base.getDay() + 6) % 7)));   // 本周一

    // 下周X / 下个星期X
    let m = text.match(/下(?:个)?(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (m) {
      const t = map[m[1]];
      const d = addDays(addDays(thisMon, 7), t === 0 ? 6 : t - 1);
      return { date: d, label: fmtHumanY(d), explicit: true };
    }
    // 周X / 星期X / 礼拜X —— 取「还没到的那一个」
    m = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/);
    if (m) {
      const t = map[m[1]];
      let d = addDays(thisMon, t === 0 ? 6 : t - 1);
      if (d.getTime() <= base.getTime()) d = addDays(d, 7);
      return { date: d, label: fmtHumanY(d), explicit: true };
    }

    return null;
  }

  /* ======================================================================
     2. 城市解析
     ====================================================================== */
  let CITY_ENTRIES = null;
  function cityEntries() {
    if (CITY_ENTRIES) return CITY_ENTRIES;
    const arr = [];
    Object.keys(CITY_AIR).forEach((k) => arr.push({ s: k, c: k }));
    Object.keys(CITY_ALIAS).forEach((k) => arr.push({ s: k, c: CITY_ALIAS[k] }));
    arr.sort((a, b) => b.s.length - a.s.length);   // 长串优先，「中国香港」不被「香港」截断
    CITY_ENTRIES = arr;
    return arr;
  }

  /**
   * 扫描文本里的城市，返回 [{ name, surface, idx }]，按出现顺序去重。
   * 保留 idx / surface 是为了后面判断方向（"从北京" vs "去成都"）。
   */
  function findCities(text) {
    const entries = cityEntries();
    const hits = [];
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (let k = 0; k < entries.length; k++) {
        if (text.startsWith(entries[k].s, i)) { hit = entries[k]; break; }
      }
      if (hit) { hits.push({ name: hit.c, surface: hit.s, idx: i }); i += hit.s.length; }
      else i++;
    }
    const out = [];
    hits.forEach((h) => { if (!out.length || out[out.length - 1].name !== h.name) out.push(h); });
    return out.slice(0, 2);
  }

  /**
   * 判断谁是出发地、谁是目的地。
   * 「从北京到成都」→ 京出发；「去成都的机票」→ 成都只是目的地，出发地不知道就说不知道。
   * 只有目的地时，用上次记下的出发地补位——省得每次都说一遍。
   */
  function resolveRoute(text, hits) {
    let from = null, to = null, guessed = false;

    if (hits.length >= 2) {
      from = hits[0].name; to = hits[1].name;
    } else if (hits.length === 1) {
      const h = hits[0];
      const before = text.slice(Math.max(0, h.idx - 2), h.idx);
      const after  = text.slice(h.idx + h.surface.length, h.idx + h.surface.length + 2);

      if (/从|由/.test(before))            from = h.name;   // 「从北京…」
      else if (/到|去|飞|往/.test(before)) to = h.name;     // 「…去成都」
      else if (/出发|起飞/.test(after))    from = h.name;   // 「北京出发」
      else                                 to = h.name;     // 只说一个城市，当目的地
    }

    if (to && !from) {
      const last = localStorage.getItem('sxm.lastFrom');
      if (last && last !== to) { from = last; guessed = true; }
    }
    return { from, to, guessed };
  }

  /**
   * 「去/到/往/飞/回 + 城市」就算出行意图 —— 哪怕用户没说「高铁」「机票」。
   * 返回 { fly }：是「飞」过去的就给飞机，否则火车+飞机都摆上。
   *
   * 判据：从城市名**向左逐字回看**，中间只许夹动量词/助词（GAP_OK），
   * 遇到的第一个别的字必须是方向词，否则不算出行。
   *
   * 为什么不用固定字数窗口（一开始就是那么写的，两个方向都翻车）：
   *  - 窗口太窄：「去一趟上海」「我要去一次深圳」（方向词和城市隔 2 字）
   *    被判成购物，弹出标题为「去一趟上海」的比价卡 —— 正是要消灭的现象。
   *  - 窗口一放宽：「回力北京布鞋」「飞猪上海迪士尼门票」这种**品牌首字恰好
   *    是方向词**的，就被认成出行（回力鞋 → 出行卡）。逐字回看两头都堵住。
   *
   * 命不中就返回 null，交给上层继续按外卖/购物判。
   */
  const DIR_WORD = /[去到往回飞]/;             // 方向词
  const GAP_OK   = /[一了趟次下个几来回\s]/;    // 允许夹在方向词与城市之间的动量词/助词
  const GAP_MAX  = 6;                          // 最多回看几个字，防止无限扫
  function directionTravel(text, hits) {
    if (!hits || !hits.length) return null;
    for (let i = 0; i < hits.length; i++) {
      const stop = Math.max(0, hits[i].idx - GAP_MAX);
      for (let k = hits[i].idx - 1; k >= stop; k--) {
        const ch = text[k];
        if (DIR_WORD.test(ch)) return { fly: ch === '飞' };
        if (!GAP_OK.test(ch)) break;   // 夹层里出现别的字（品牌名等）→ 不是出行
      }
    }
    // 城市不在方向词右边，但句子里在问「怎么走 / 怎么去 / 怎么坐车」。
    // 注意：这条只有句子里**已经有城市**才走得到（没有城市在上面第一行就返回了），
    // 所以「如何去机场」这类没城市、也没别的线索的，仍按原样落到购物分支 ——
    // 有意为之：把「怎么去」无条件当出行，会把「怎么去黑头」也算成出行。
    if (/怎么(?:走|去|到|坐车|坐地铁)|咋(?:走|去)|如何去|怎样去/.test(text)) return { fly: false };
    return null;
  }

  /* ======================================================================
     3. 意图解析
     ====================================================================== */
  const RE_RAIL  = /高铁|火车|动车|车票|12306|铁路|卧铺|候补/;
  const RE_AIR   = /机票|航班|飞机|飞往|直飞|航空/;
  const RE_FOOD  = /外卖|点餐|点个|点一份|想吃|想喝|来一份|来一杯|奶茶|咖啡|麻辣烫|烧烤|火锅|炸鸡|披萨|汉堡|麦当劳|肯德基|必胜客|星巴克|瑞幸|蜜雪|便当|午饭|晚饭|夜宵|早餐/;
  /* 「弱」外卖信号：问「吃什么」也算想吃，但这些词本身也可能出现在购物句里
     （「好吃的饼干买哪个」）。所以它们只有在**没有购物词**时才当外卖，
     而 RE_FOOD 里的词（外卖/火锅/麦当劳…）是强信号，命中即外卖。 */
  const RE_FOOD_WEAK = /吃什么|吃啥|吃点啥|吃点什么|好吃的|喝什么|喝啥/;
  const RE_SHOP  = /买|购|多少钱|价格|比价|划算|值得|优惠|降价|折扣/;
  /* 判「这句话到底想买东西、还是想赶路」时用的一对词表。
     RE_BUY 是**真购物**信号；RE_SHOP 里的「多少钱 / 价格」太弱，不能拿它
     否掉出行 —— 「去上海多少钱」问的是票价。而碰上「票」，说明要的仍是行程。 */
  const RE_BUY    = /买|购|入手|拿下|下单|拼单/;
  const RE_TICKET = /票|客运|班次|卧铺/;

  function parseIntent(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const date   = parseDate(text);
    const hits   = findCities(text);
    const cities = hits.map((h) => h.name);

    const isRail = RE_RAIL.test(text);
    const isAir  = RE_AIR.test(text);
    // 弱外卖信号要避开购物句：「好吃的饼干买哪个」问的是买，不是吃
    const isFood = RE_FOOD.test(text) || (RE_FOOD_WEAK.test(text) && !RE_SHOP.test(text));

    /* 出行才需要日期。写了个不存在的日子（2月30日）就先说清楚，
       绝不放行到渲染层 —— 否则卡片会写「3月2日 周二 · 按你说的」。
       购物比价和日期无关，所以只有出行分支拦这里。 */
    const badDate = (date && date.invalid) ? date : null;
    const needDate = () => ({ type: 'needDate', date: badDate, cities, raw: text });

    // ---- 出行：明说了火车或飞机 ----
    if (isRail || isAir) {
      if (badDate) return needDate();
      const r = resolveRoute(text, hits);
      return {
        type: isAir && !isRail ? 'air' : (isRail && !isAir ? 'rail' : 'both'),
        from: r.from, to: r.to, fromGuessed: r.guessed,
        cities, date, raw: text
      };
    }

    // ---- 出行：只说了「北京到上海」，工具没说 → 火车飞机一起给 ----
    // 判据不是「出现了两个城市」，而是「两个城市之间有方向词」。
    // 否则「帮我买北京烤鸭和天津麻花」会被误判成一条路线——这是真实踩过的坑。
    if (hits.length >= 2) {
      const gap = text.slice(hits[0].idx + hits[0].surface.length, hits[1].idx);
      if (/[到去飞往至]|→|->|—|--|到/.test(gap)) {
        if (badDate) return needDate();
        const r = resolveRoute(text, hits);
        return { type: 'both', from: r.from, to: r.to, fromGuessed: r.guessed, cities, date, raw: text };
      }
    }

    /* ---- 出行：明确写了「从…到…」，但凑不成一条路线 ----
       实测踩过的坑：「从北京到北京」只认出 1 个城市，于是掉进下面的购物分支，
       弹出一张标题为「从北京到北京」的比价卡。写了方向词就是想出行，
       只是信息不够 —— 该反问，不是拿它去比价。 */
    if (hits.length >= 1 && /从\s*[^\s]{1,8}\s*到\s*[^\s，,。]{1,8}/.test(text)) {
      if (badDate) return needDate();
      return { type: 'needRoute', cities, date, raw: text };
    }

    /* ---- 出行：只说了「方向词 + 城市」，工具没说 → 按出行处理 ----
       实测踩过的坑：「去上海」「到北京」「飞成都」「回广州」「订张去上海的票」
       「上海怎么走」全都掉进了购物分支，弹出一张标题为「去上海」的比价卡 ——
       用户明摆着要出行，界面却在给他比价。方向词在城市的左边，就是出行信号。

       要不要让位给购物，只看**真购物**信号（RE_BUY 且没有「票」字）：
       「去上海买表」让位（买表），「订张去上海的票」不让位（要的是行程）。
       一开始这里是 `!RE_SHOP.test(text)`，被「购」字坑了 ——
       「订购去上海的票」判成购物、「订购北京到上海的票」却能出行，
       同样意思两个结果；「去上海多少钱」也被「多少钱」翻成购物。
       外卖词（isFood）另外让位，见前面分支。 */
    const wantsBuy = RE_BUY.test(text) && !RE_TICKET.test(text);
    const dirTravel = directionTravel(text, hits);
    if (dirTravel && !isFood && !wantsBuy) {
      if (badDate) return needDate();
      const r = resolveRoute(text, hits);
      // 走到这里 isRail 必为 false（火车/飞机在前面就返回了），不用再判
      return {
        type: dirTravel.fly ? 'air' : 'both',
        from: r.from, to: r.to, fromGuessed: r.guessed,
        cities, date, raw: text
      };
    }

    // ---- 外卖 ----
    if (isFood) {
      return { type: 'food', city: cities[0] || null, date, raw: text };
    }

    // ---- 默认：购物比价 ----
    const product = extractProduct(text);
    if (!product) return { type: 'needProduct', date, cities, raw: text };
    return { type: 'shop', product, date, cities, raw: text };
  }

  /* 剥完之后如果只剩套话/符号，也不该当商品名 —— 见 extractProduct 的注释 */
  const FILLER_ONLY = /^(帮我|帮忙|麻烦|给我|我要|我想|想要|想|请|替我|买个|买一个|买|要|看看|看一下|查一下|查查|查|搜一下|搜搜|搜|比一下|比一比|比价|比较|一下|一个|个|的|推荐|求推荐|安利|种草|介绍)+$/;

  /** 纯函数：这段文字算不算一个「商品名」。空、纯符号/emoji、纯套话都不算。 */
  function isMeaningfulProduct(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return false;
    // 去掉空白、标点、符号（含 emoji）后一个字都不剩 → 不是商品名（「🎧🎧」「!!!」）
    if (!t.replace(/[\s\p{P}\p{S}]/gu, '')) return false;
    if (FILLER_ONLY.test(t)) return false; // 「帮我买」「想买」「比一比」也不是商品名
    return true;
  }

  /** 从「帮我买 AirPods Pro 3」里抠出「AirPods Pro 3」 */
  function extractProduct(text) {
    const src = String(text == null ? '' : text);
    let s = src;

    // ① 套话前缀
    s = s.replace(/^(帮我|帮忙|麻烦|给我|我要|我想|想要|想|请|替我)\s*/, '');

    /* ② 推荐 / 求推荐 类问法：剥掉「问法框架」，留下商品名。
       实测踩过的坑：这些原来全是同一类 —— 整句被当成商品名，弹出一张
       标题为「推荐个耳机」的比价卡，真实模式下还会拿整句去搜平台。
       「求推荐」是后缀（笔记本电脑求推荐）；「推荐」**必须带量词才剥**，
       否则「推荐算法」这种本来就含"推荐"二字的商品名会被切坏。 */
    s = s.replace(/(?:求推荐|求安利|求种草)\s*$/g, '');
    s = s.replace(/^(?:求推荐|求安利|求种草)\s*/, '');
    /* 量词表刻意收窄：不放「双 / 台 / 部 / 件」，否则「推荐双肩包」「推荐台灯」
       会被切成「肩包」「灯」。「点儿 / 一点 / 一下」要排在单字前面先匹配。 */
    s = s.replace(/^(?:推荐|安利|种草)\s*(?:点儿|一点|一下|一|个|款|下|几|点|些|了)+\s*/, '');
    s = s.replace(/^(?:有没有|有木有|有没|有什么|有啥)\s*(?:好用|不错|比较好|好|值得|靠谱|性价比高)?的?\s*/, '');
    s = s.replace(/^(?:哪|那)(?:款|个|种|一款|一个|牌子|品牌)\s*/, '');

    // ③ 购物动词
    s = s.replace(/^(买个|买一个|买台|买部|买件|买只|入手|拿下|看看|看一下|查一下|查查|查|搜一下|搜搜|搜|比一下|比一比|比价|比较)\s*/, '');
    s = s.replace(/^(买|要)\s*/, '');

    // ④ 问法后缀
    s = s.replace(/(多少钱|什么价|什么价格|价格|比价|值得买吗|值得入手吗|怎么样|贵不贵|划算吗|哪家便宜)[？?。！!~～]*\s*$/g, '');
    /* 「哪款耳机好」「有没有耳机好用」里的「好 / 好用 / 吗 / 呢」是评价词，不是商品名。
       但它们**只在整句本来就是问句时才敢剥** —— 否则「洗发水好」这种
       以「好」结尾的说法会被误切。 */
    if (/^(?:哪|那|什么|啥|有没有|有木有|有没|求|推荐|安利|种草)/.test(src)) {
      s = s.replace(/\s*(?:好用吗|好不好用|好用|好|吗|呢)[？?。！!~～]*\s*$/g, '');
    }
    s = s.replace(/^的\s*/, '');
    s = s.replace(/[？?。！!]+$/, '');
    const out = s.trim();
    /* 剥掉「帮我买」这类套话后什么都不剩（或只剩 emoji / 标点 / 又一堆套话），
       说明用户压根没给商品名。这时候**绝不能回落到原文** ——
       实测踩过的坑：「帮我买 」的原文被当成商品名，界面弹出一张
       标题为「帮我买」的比价卡；「帮我买 🎧🎧」就去按 emoji 比价。
       真实模式下更糟：白打一轮平台接口、烧配额，拿回一堆无关商品。
       返回空串，上层会反问一句「想买什么」——一次对话就解决了。 */
    return isMeaningfulProduct(out) ? out : '';
  }

  /* ======================================================================
     4. 渲染：购物比价
     ====================================================================== */
  /** 演示用价格：由商品名做确定性散列，保证同一个商品每次显示一致 */
  function demoPrices(product) {
    let h = 0;
    for (let i = 0; i < product.length; i++) h = (h * 31 + product.charCodeAt(i)) >>> 0;
    const base = 199 + (h % 2800);
    return SHOP_PLATFORMS.map((p, i) => {
      const k = ((h >> (i * 3)) % 100) / 100;
      const price  = Math.round(base * (0.86 + k * 0.30));
      const coupon = ((h >> (i + 2)) % 3 === 0) ? Math.round(price * 0.07) : 0;
      return { id: p.id, price, coupon, final: price - coupon };
    });
  }

  /**
   * 演示用的「实时比价」载荷。
   *
   * 它存在的唯一理由：没有联盟密钥时，接好之后长什么样用户根本看不到，
   * 于是"有没有做过"和"做得好不好"都无从判断。
   * 所以这里刻意复用 renderShopLive 的同一条渲染路径（含历史曲线），
   * 并强制带 demo:true —— 卡片会自动打上「演示数据 · 非实时」。
   * 渲染路径同一条，才不会出现"演示时好看、真接入后走样"。
   */
  function demoLive(product) {
    let h = 0;
    for (let i = 0; i < product.length; i++) h = (h * 31 + product.charCodeAt(i)) >>> 0;
    const rnd = (i) => ((h >> (i * 3)) % 100) / 100;

    const PLAT = [
      { id: 'jd',      name: '京东',      base: 0.98 },
      { id: 'pdd',     name: '拼多多',     base: 0.88 },
      { id: 'dataoke', name: '淘宝 / 天猫', base: 0.94 }
    ];
    const mid = 199 + (h % 2600);

    const platforms = PLAT.map((p, pi) => {
      const anchor = Math.round(mid * p.base * (0.97 + rnd(pi) * 0.08));

      const items = [0, 1, 2].map((k) => {
        const final = Math.round(anchor * (1 + k * 0.07 + rnd(pi + k) * 0.05));
        const coupon = Math.round(final * (k === 0 ? 0.08 : 0.03));
        return {
          sku: p.id + '-' + (h % 90000 + pi * 7 + k),
          title: k === 0 ? product + '（官方旗舰店）' : product + ' ' + ['标准版', '升级版', '套装'][k - 1],
          price: final + coupon,
          coupon,
          final,
          url: '#demo',
          shop: ['某某自营旗舰店', '某某官方旗舰店', '某某专营店'][k],
          sales: 30000 - k * 7000 - pi * 1500,
          commissionRate: 3 + pi
        };
      });
      items.sort((a, b) => a.final - b.final);

      /* 演示也要带历史曲线：这是这一轮最有差异化的能力，
         不展示出来等于没做。数据是生成的，所以卡片必须同时标明"演示"。 */
      const n = 10, pts = [];
      const start = Math.round(items[0].final * (1.12 + rnd(pi) * 0.1));
      for (let i = 0; i < n; i++) {
        const drift = (items[0].final - start) * (i / (n - 1));
        const noise = (rnd(pi + i) - 0.5) * items[0].final * 0.03;
        pts.push({
          t: Date.now() - (n - 1 - i) * 86400000,
          f: Math.max(1, Math.round(start + drift + noise))
        });
      }
      const finals = pts.map((x) => x.f);
      const lowest = Math.min.apply(null, finals);
      const highest = Math.max.apply(null, finals);
      const latest = finals[finals.length - 1];
      const over = lowest ? (latest - lowest) / lowest : 0;

      return {
        id: p.id, name: p.name, platform: p.name,
        ok: true, count: items.length, ms: 120 + pi * 60,
        lowest: Object.assign({}, items[0], {
          history: {
            count: pts.length, lowest, highest, latest,
            verdict: latest <= lowest ? 'lowest' : (over <= 0.02 ? 'near-lowest' : 'mid'),
            verdictText: latest <= lowest
              ? '这是采集以来的最低价'
              : (over <= 0.02
                ? '已接近采集以来的最低价（高 ' + (over * 100).toFixed(1) + '%）'
                : '离采集以来的最低价还差 ¥' + (latest - lowest).toFixed(2)),
            points: pts
          }
        }),
        items, note: '', rawSample: null
      };
    }).sort((a, b) => a.lowest.final - b.lowest.final);

    return {
      demo: true, query: product, at: Date.now(),
      platforms, unconfigured: [], disclaimer: '演示数据'
    };
  }

  function renderShop(intent, warnNote) {
    const product = intent.product || '';
    const q = enc(product);
    const demo = DEMO_MODE ? demoPrices(product) : null;
    const cheapest = demo ? demo.reduce((a, b) => (b.final < a.final ? b : a)) : null;

    const rows = SHOP_PLATFORMS.map((p) => {
      const d = demo && demo.find((x) => x.id === p.id);
      const best = !!(d && cheapest && d.id === cheapest.id);

      const right = d
        ? `<div class="price"><span class="cny">¥</span>${d.final}</div>` +
          `<div class="price-old">${d.coupon ? '券前 ¥' + d.price : '&nbsp;'}</div>`
        : `<div class="price-na">去平台看实时价</div>`;

      return `
        <div class="row ${best ? 'row-cheapest' : ''}">
          <div class="pf ${p.cls}">${esc(p.abbr)}</div>
          <div class="row-main">
            <div class="row-name">${esc(p.name)}
              ${p.tag ? `<span class="badge ${best ? 'badge-best' : ''}">${best ? '当前最低' : esc(p.tag)}</span>` : ''}
            </div>
            <div class="row-desc">${esc(p.desc || '')}</div>
          </div>
          <div class="row-right">
            ${right}
            <a class="go ${best ? 'go-brand' : ''}" href="${p.url.replace('{q}', q)}" target="_blank" rel="noopener noreferrer">打开</a>
          </div>
        </div>`;
    }).join('');

    const banner = demo
      ? `<div class="banner banner-warn"><span class="banner-ico">!</span>
           <span><strong>演示数据 · 非实时。</strong>下面这串价格是按商品名生成的样例，只为让你看到接入联盟接口后的样子，不能当报价用。
           在「接入状态」里关掉效果预览即可恢复。</span></div>`
      : `<div class="banner banner-info"><span class="banner-ico">i</span>
           <span>这 6 个入口的搜索结果都是<strong>实时</strong>的，价格请以页面为准。要让我把价格直接拉进一张表横着比，
           得接入淘宝客 / 京东联盟这类<strong>官方联盟接口</strong>——见右上角「接入状态」。</span></div>`;

    return `
      <div class="card-head">
        <div>
          <div class="card-title">「${esc(product)}」该去哪买</div>
          <div class="card-note">6 个平台的搜索页已经备好，点「打开」就是搜好的结果</div>
        </div>
        <span class="tag ${demo ? 'tag-mute' : 'tag-shop'}">${demo ? '演示' : '比价'}</span>
      </div>
      ${warnNote ? `<div class="banner banner-danger"><span class="banner-ico">!</span>
        <span>${esc(warnNote)}</span></div>` : ''}
      ${banner}
      <div class="rows">${rows}</div>
      <div class="banner banner-warn" style="margin-top:12px">
        <span class="banner-ico">※</span>
        <span>比价别只看标价。<strong>到手价 = 标价 − 平台券 − 店铺券 − 支付立减</strong>，
        同一件东西在两家店的差距通常就藏在这四项里。商品页和结算页都看一眼，才算真比过。</span>
      </div>
      <div class="card-actions">
        <button class="copy-btn" type="button" data-share="${esc(intent.product)}">分享链接</button>
      </div>`;
  }

  /* ======================================================================
     4.5 渲染：实时比价（有服务端数据时走这条）
     ====================================================================== */
  function fmtPrice(n) {
    if (n == null) return '—';
    return Number.isInteger(n) ? String(n) : Number(n).toFixed(2);
  }

  const money = (n) => '<span class="cny">¥</span>' + fmtPrice(n);

  /**
   * 价格历史迷你曲线。
   *
   * 关键取舍：**点少于 2 个就不画线。**
   * 一个点连不成线，硬画出来那条"趋势"是假的——用户会据此判断涨跌，
   * 这是最不该骗人的地方。样本不够时只说明情况，不画。
   */
  function spark(history) {
    if (!history || !history.count) return '';

    if (!Array.isArray(history.points) || history.points.length < 2) {
      return `<div class="spark-text" style="margin:6px 0 0">
        价格历史从这次开始记录（第 ${history.count} 次）。多比几次才会出现走势线。
      </div>`;
    }

    const pts = history.points.slice(-24);
    const W = 88, H = 26, PAD = 3;
    const fs = pts.map((p) => Number(p.f));
    const lo = Math.min.apply(null, fs);
    const hi = Math.max.apply(null, fs);
    const span = (hi - lo) || 1;
    const x = (i) => PAD + (i * (W - PAD * 2)) / (pts.length - 1);
    const y = (f) => H - PAD - ((f - lo) / span) * (H - PAD * 2);

    const d = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(Number(p.f)).toFixed(1)).join(' ');
    const lx = x(pts.length - 1).toFixed(1);
    const ly = y(Number(pts[pts.length - 1].f)).toFixed(1);

    const meta = history.count >= 3
      ? `采集 ${history.count} 次 · 低 ¥${fmtPrice(history.lowest)} / 高 ¥${fmtPrice(history.highest)}`
      : `已采集 ${history.count} 次`;

    return `
      <div class="spark spark-v-${esc(history.verdict || 'unknown')}">
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          <path class="spark-line" d="${d}"></path>
          <circle class="spark-dot" cx="${lx}" cy="${ly}" r="2.6"></circle>
        </svg>
        <div class="spark-text"><b>${esc(history.verdictText || '')}</b><br>${esc(meta)}</div>
      </div>`;
  }

  function renderShopLive(product, data) {
    const isDemo = !!data.demo;
    // 这张卡自己的复制文本，id 跟着卡片走 —— 页面上多张卡也不会互相覆盖
    const copyId = registerCopyText(shopLiveToText(product, data));

    /* 降价提醒：拿「上次自己记录的价」和这次比出来的最低价对一下。
       演示数据是编的，永远不参与关注，否则提醒的是假降价。
       注意：这里会顺手把已提醒的记录更新成当前价 —— 一次降价只提醒一次，
       之后等下一次再降才有新提醒。 */
    const qKey = String(product).trim().toLowerCase();
    let dropBanners = '';
    if (!isDemo) {
      dropBanners = watchList().filter((w) => w.qKey === qKey).map((w) => {
        const p = (data.platforms || []).find((x) => x.id === w.platform && x.ok && x.count && x.lowest);
        if (!p) return '';
        const drop = priceDrop(w.price, p.lowest.final);
        if (!drop) return '';
        watchRemove(w.qKey, w.platform);
        watchAdd({ q: w.q, platform: w.platform, sku: w.sku, title: w.title, price: p.lowest.final });
        return `<div class="banner banner-ok watch-banner"><span class="banner-ico">↓</span>
          <span>降价提醒：「${esc(w.q)}」在${esc(p.name)}从 ¥${fmtPrice(w.price)}
          降到 <b>¥${fmtPrice(p.lowest.final)}</b>，比上次记录便宜 ¥${fmtPrice(drop.saved)}。</span></div>`;
      }).join('');
    }

    const groups = data.platforms.map((p) => {
      // 平台没返回结果 —— 把原因摆出来，尤其是「字段名变了」这种可修的
      if (!p.ok || p.count === 0) {
        const detail = p.rawSample
          ? `<br>接口返回的字段名是：<code>${esc(p.rawSample.join(', '))}</code>`
          : '';
        return `
          <div class="live-group">
            <div class="live-head">
              <span class="live-plat">${esc(p.name)}</span>
              <span class="live-low">没拿到</span>
            </div>
            <div class="live-empty">${esc(p.note || '该关键词没有推广商品')}${detail}</div>
          </div>`;
      }

      /* 关注按钮只在真实数据上出现：演示价格是编的，关注它等于记假账 */
      const watchBtn = !isDemo ? `
        <button class="watch-btn" type="button" data-watch="1"
          data-q="${esc(product)}" data-platform="${esc(p.id)}" data-plat-name="${esc(p.name)}"
          data-sku="${esc((p.lowest && p.lowest.sku) || '')}"
          data-title="${esc((p.lowest && p.lowest.title) || '')}"
          data-price="${esc(String(p.lowest.final))}">关注降价</button>` : '';

      const rows = p.items.map((it, i) => `
        <div class="row row-noicon ${i === 0 ? 'row-cheapest' : ''}">
          <div class="row-main">
            <div class="row-name">${esc(it.title)}</div>
            <div class="row-desc">${
              [it.shop ? esc(it.shop) : '',
               it.sales ? '月销 ' + it.sales : '',
               it.commissionRate ? '佣金 ' + it.commissionRate : ''
              ].filter(Boolean).join(' · ') || '&nbsp;'
            }</div>
          </div>
          <div class="row-right">
            <div class="price"><span class="cny">¥</span>${fmtPrice(it.final)}</div>
            <div class="price-old">${it.coupon > 0 ? '券前 ¥' + fmtPrice(it.price) : '&nbsp;'}</div>
            ${data.demo
              // 演示数据的链接是占位符。做成能点的按钮等于给用户一个假入口，
              // 点了什么都不会发生 —— 那比不放按钮更让人恼火。
              ? '<div class="price-na" style="margin-top:5px">样例</div>'
              : `<a class="go ${i === 0 ? 'go-brand' : ''}" href="${esc(it.url)}"
                    target="_blank" rel="noopener noreferrer">打开</a>`}
          </div>
        </div>`).join('');

      const more = p.count > p.items.length ? `，共 ${p.count} 条` : '';
      return `
        <div class="live-group">
          <div class="live-head">
            <span class="live-plat">${esc(p.name)}</span>
            <span class="live-low">最低 <b>¥${fmtPrice(p.lowest.final)}</b>${more}</span>
            ${watchBtn}
          </div>
          ${spark(p.lowest && p.lowest.history)}
          <div class="rows">${rows}</div>
        </div>`;
    }).join('');

    const idle = data.unconfigured.length
      ? `<div class="live-empty" style="margin-top:12px">这些平台还没配密钥，配上就会一起比进来：${
          data.unconfigured.map((u) => esc(u.name)).join('、')
        }</div>`
      : '';

    /* 演示模式（？demo=1 或抽屉里打开）走的是同一套渲染，
       区别只有标签和顶部提示 —— 这样"看到的样子"和"真实的样子"必然一致，
       不会出现"演示时好看、真接入后走样"的情况。 */
    const banner = isDemo
      ? `<div class="banner banner-warn"><span class="banner-ico">!</span>
           <span><strong>演示数据 · 非实时。</strong>这一屏的价格和历史曲线都是按商品名生成的样例，
           只为让你看到接入联盟接口后的完整形态，<strong>不能当报价用</strong>。
           去「接入状态」关掉效果预览即可恢复。</span></div>`
      : `<div class="banner banner-warn"><span class="banner-ico">!</span>
           <span>${esc(data.disclaimer)}</span></div>`;

    return `
      <div class="card-head">
        <div>
          <div class="card-title">「${esc(product)}」实时比价</div>
          <div class="card-note">各平台搜索最低价的对照，按到手价排序</div>
        </div>
        ${isDemo ? '<span class="tag tag-mute">演示</span>' : '<span class="tag tag-ok">实时</span>'}
      </div>
      ${banner}
      ${dropBanners}
      ${groups}
      ${idle}
      <div class="card-actions">
        <button class="copy-btn" type="button" data-share="${esc(product)}"
          data-share-demo="${isDemo ? '1' : ''}">分享链接</button>
        <button class="copy-btn" type="button" data-copy="${copyId}">复制结果</button>
      </div>`;
  }

  /* ======================================================================
     4.6 渲染：省钱清单
     ----------------------------------------------------------------------
     这是这一轮最有差异化的东西。
     现有比价工具把价格横着摆一排就结束了，把决策留给了用户。
     但用户真正的处境是：**要买好几样东西，而且不想装一堆 App。**
     所以这张卡只回答一个问题：该分几家买，还是一家买齐？差价值不值得折腾？
     ====================================================================== */
  function renderBasket(data) {
    const items = data.items || [];
    const perQ  = data.perQuery || [];
    // 清单卡也有自己的复制文本 id：和比价卡并存时不会串
    const copyId = registerCopyText(basketToText(data));

    const isSplit = data.recommend === 'split';
    const isNone  = data.recommend === 'none';
    const head = isNone
      ? { t: '暂时给不出方案', ico: '?' }
      : (isSplit ? { t: '建议分开买', ico: '↗' } : { t: '建议一家买齐', ico: '✓' });

    /* 两个方案都摆出来，而不是只说自己推荐的那个。
       用户应该能自己复核我的建议 —— 只给结论的推荐叫命令。 */
    const planRows = [];
    if (!isNone) {
      const who = ((data.split && data.split.platforms) || [])
        .map((p) => esc(p.name) + ' ¥' + fmtPrice(p.subtotal)).join('　');
      planRows.push(`
        <div class="plan-row ${isSplit ? 'pick' : ''}">
          <div>
            <div class="plan-name">分件买最优${isSplit ? ' <span class="badge badge-best">建议</span>' : ''}</div>
            <div class="plan-meta">${(data.split && data.split.platformCount) || 0} 个平台：${who || '—'}</div>
          </div>
          <div class="plan-total">${money(data.split ? data.split.total : 0)}</div>
        </div>`);

      (data.singles || []).slice(0, 2).forEach((s, i) => {
        const pick = !isSplit && i === 0;
        planRows.push(`
          <div class="plan-row ${pick ? 'pick' : ''}">
            <div>
              <div class="plan-name">都在「${esc(s.name)}」买齐${pick ? ' <span class="badge badge-best">建议</span>' : ''}</div>
              <div class="plan-meta">只开 1 个 App，少在 ${Math.max(0, items.length - 1)} 个地方填地址</div>
            </div>
            <div class="plan-total">${money(s.total)}</div>
          </div>`);
      });

      if (data.savingVsWorstSingle > 0) {
        planRows.push(`<div class="live-empty">分件买比最便宜的「一家买齐」省 <b>¥${
          fmtPrice(data.savingVsBestSingle)}</b>，比最贵的买齐方案省 <b>¥${
          fmtPrice(data.savingVsWorstSingle)}</b>。</div>`);
      }
    }

    const detail = items.map((it, i) => {
      const pq = perQ[i] || {};
      if (!it.best) {
        return `<div class="basket-item">
          <div>
            <div class="bi-q">${esc(it.q)}</div>
            <div class="bi-sub">这件没拿到价格${pq.error ? '（' + esc(pq.error) + '）' : ''}，没有算进总价</div>
          </div>
          <div class="bi-right"><div class="price-na">—</div></div>
        </div>`;
      }
      const runner = it.runnerUp
        ? '（次低是 ' + esc(it.runnerUp.name) + ' ¥' + fmtPrice(it.runnerUp.final)
          + (it.gapToRunnerUp > 0 ? '，贵 ¥' + fmtPrice(it.gapToRunnerUp) : '，同价') + '）'
        : '';
      // 演示数据的链接是占位符，不能做成能点的假按钮
      const go = pq.best && pq.best.url && pq.best.url !== '#demo'
        ? `<a class="go go-brand" href="${esc(pq.best.url)}" target="_blank" rel="noopener noreferrer">打开</a>`
        : '';
      return `<div class="basket-item">
        <div>
          <div class="bi-q">${esc(it.q)}</div>
          <div class="bi-sub">最便宜在「${esc(it.best.name)}」${runner}</div>
        </div>
        <div class="bi-right">
          <div class="bi-price">${money(it.best.final)}</div>
          ${go}
        </div>
      </div>`;
    }).join('');

    const notes = (data.notes || []).length
      ? `<div class="banner banner-info" style="margin-top:12px"><span class="banner-ico">i</span>
           <span>${data.notes.map((n) => esc(n)).join('<br>')}</span></div>`
      : '';

    const failed = (data.failed || []).length
      ? `<div class="live-empty" style="margin-top:16px">这 ${
          data.failed.length} 件没问通，其余照常算了：${data.failed.map((f) => esc(f.q)).join('、')}</div>`
      : '';

    return `
      <div class="card-head">
        <div>
          <div class="card-title">省钱清单怎么买</div>
          <div class="card-note">${items.length} 件商品 · 逐件比完再算总账</div>
        </div>
        ${data.demo ? '<span class="tag tag-mute">演示</span>' : '<span class="tag tag-ok">实时</span>'}
      </div>
      <div class="card-actions"><button class="copy-btn" type="button" data-copy="${copyId}">复制结果</button></div>
      <div class="verdict">
        <span class="verdict-ico">${head.ico}</span>
        <div>
          <div class="verdict-t">${head.t}</div>
          <div class="verdict-d">${esc(data.reason || '')}</div>
        </div>
      </div>
      ${planRows.length ? `<div class="plan">${planRows.join('')}</div>` : ''}
      ${detail ? `<div class="mini-title">逐件明细</div><div class="rows">${detail}</div>` : ''}
      ${failed}
      ${notes}`;
  }

  /** 纯前端模式下的清单：不给总价，只把入口摆好 —— 编一个总价比不给更糟 */
  function renderBasketOffline(queries) {
    const rows = queries.map((q) => `
      <div class="basket-item">
        <div><div class="bi-q">${esc(q)}</div><div class="bi-sub">本地算不了总账，先去平台看实时价</div></div>
        <div class="bi-right">
          <a class="go" href="${SHOP_PLATFORMS[0].url.replace('{q}', enc(q))}"
             target="_blank" rel="noopener noreferrer">打开</a>
        </div>
      </div>`).join('');

    return `
      <div class="card-head">
        <div>
          <div class="card-title">省钱清单</div>
          <div class="card-note">需要服务端做跨平台询价，当前没连上</div>
        </div>
        <span class="tag tag-mute">降级</span>
      </div>
      <div class="banner banner-warn"><span class="banner-ico">!</span>
        <span>清单必须<strong>把所有商品都比完</strong>才能算总账，只有服务端能一次问完各平台。
        现在没连上 <code>/api/compare</code>，所以我<strong>不会给你编一个总价</strong>。
        启动服务端（<code>node server/server.js</code>）后这里就会变成真的。</span></div>
      <div class="rows">${rows}</div>`;
  }

  /* ======================================================================
     5. 渲染：外卖
     ====================================================================== */
  function renderFood(intent) {
    const city = intent.city;
    const rows = FOOD_PLATFORMS.map((p) => `
      <div class="row">
        <div class="pf ${p.cls}">${esc(p.abbr)}</div>
        <div class="row-main">
          <div class="row-name">${esc(p.name)} <span class="badge">${esc(p.tag)}</span></div>
          <div class="row-desc">打开后走「我的 → 红包卡券 / 领券中心」，先领再点</div>
        </div>
        <div class="row-right">
          <div class="price-na">券以平台为准</div>
          <a class="go" href="${p.url}" target="_blank" rel="noopener noreferrer">打开</a>
        </div>
      </div>`).join('');

    const tips = FOOD_TIPS.map((t, i) =>
      `<div class="tip"><span class="tip-n">${i + 1}</span><span>${esc(t)}</span></div>`).join('');

    return `
      <div class="card-head">
        <div>
          <div class="card-title">外卖${city ? ' · ' + esc(city) : ''}</div>
          <div class="card-note">我的活是让你少花钱，不是替你点单——所以只给入口和打法</div>
        </div>
        <span class="tag tag-food">外卖</span>
      </div>
      <div class="rows">${rows}</div>
      <div class="mini-title">下单前的四个动作</div>
      <div class="tips">${tips}</div>
      <div class="banner banner-info" style="margin-top:12px">
        <span class="banner-ico">i</span>
        <span>外卖券的实时聚合要接<strong>好单库</strong>这类聚合接口（个人可注册）。
        接上之后这里会直接列出当天可领的红包；现在先手动领，差别只是多几步点击，钱是一样的。</span>
      </div>`;
  }

  /* ======================================================================
     5.5 出行方式取舍：靠坐标算，不靠感觉
     ----------------------------------------------------------------------
     火车票没有跨平台价差（全国统一价），所以「比价」在这里唯一有意义的形态
     是比走法：高铁 vs 飞机，门到门到底谁快。这个能算，而且用公开数据就能算。
     ====================================================================== */
  const R_EARTH = 6371;

  /** 两点大圆（直线）距离，单位公里 */
  function greatCircle(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b[0] - a[0]);
    const dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  }

  /**
   * 门到门耗时粗估。
   * 高铁：含停站有效速度约 250km/h，再加进出站与安检约 0.5h。
   * 飞机：巡航约 700km/h，但必须再加往返机场 + 安检 + 提前到达约 3h。
   * 这两个系数是常识层面的经验值，只用于量级判断——卡片上必须标明是粗估。
   */
  function estimateModes(km) {
    return { rail: km / 250 + 0.5, air: km / 700 + 3.0 };
  }

  /** 4.78 → 「4 小时 45 分」 */
  function humanHours(h) {
    const total = Math.round((h * 60) / 15) * 15;   // 取整到 15 分钟
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    if (hh === 0) return `${mm} 分钟`;
    return mm === 0 ? `${hh} 小时` : `${hh} 小时 ${mm} 分`;
  }

  /** 给结论，而不是把两个数字丢给用户自己算 */
  function modeVerdict(km) {
    if (km < 500)  return { pick:'rail', text:'这么近就别去机场了。算上往返和安检，飞机一点都不快，高铁准点率还高得多。' };
    if (km < 900)  return { pick:'rail', text:'高铁更稳。飞机虽然天上快，但那 3 小时机场时间省不掉，加上准点率，往往还是高铁省心。' };
    if (km < 1300) return { pick:'tie',  text:'两者门到门时间很接近，看具体时刻。想省钱看高铁二等座，想省体力看飞机。' };
    if (km < 2000) return { pick:'air',  text:'这条线飞机明显划算，门到门能省几个小时。除非你要在沿线中途下车。' };
    return { pick:'air', text:'距离太远，飞机基本是唯一现实选择。也可以看看有没有夕发朝至的卧铺当省钱方案。' };
  }

  /* ======================================================================
     6. 渲染：出行
     ====================================================================== */
  /* 常用城市：缺地址时给快捷键，省得用户再打一遍字。
     只放最常飞的一批，不做全量字典 —— 太长反而不好点。 */
  const QUICK_CITIES = ['北京', '上海', '广州', '深圳', '成都', '杭州', '西安', '重庆', '南京', '武汉'];

  /**
   * 缺出发地 / 目的地时，**主动向用户请求地址**。
   * 不只丢一句话：给可点的城市快捷键，点一下就补进输入框。
   */
  function renderRoute(intent) {
    const { from, to, date, type } = intent;

    if (!from || !to) {
      const needFrom = !from;
      const needTo   = !to;
      const missText = needFrom && needTo ? '出发地和目的地'
                     : needFrom ? '出发地' : '目的地';
      // 把已认出的那个城市填进提示，减少用户重复输入
      const known = from || to;

      const chips = QUICK_CITIES.map((c) => {
        // 已经认出另一个城市时，点同名城市没意义
        if (known && c === known) return '';
        const fill = known
          ? (needFrom ? c + '到' + known : known + '到' + c)
          : c;
        return `<button class="chip" type="button" data-fill="${esc(fill)}">${esc(c)}</button>`;
      }).join('');

      return `
        <div class="card-head">
          <div>
            <div class="card-title">告诉我${missText}</div>
            <div class="card-note">${known
              ? '已经认出「' + esc(known) + '」，再补上另一个就能查'
              : '比如「北京到上海 下周三」'}</div>
          </div>
          <span class="tag tag-trip">出行</span>
        </div>
        <div class="banner banner-warn"><span class="banner-ico">?</span>
          <span>${intent.cities && intent.cities.length
            ? '现在只认出了：' + esc(intent.cities.join('、')) + '。'
            : ''}${esc(missText)}都给我，我才能把航班和车次列出来 —— 猜一个给你，
            查出来大概率是错的航线。</span></div>
        <div class="mini-title">常用城市（点一下补进输入框）</div>
        <div class="chips">${chips}</div>`;
    }

    // 日期没给 → 按明天算，但必须在卡上写明这是默认值
    const fallback = addDays(baseToday(), 1);
    const d = date || { date: fallback, label: fmtHumanY(fallback), explicit: false };
    const iso = fmtISO(d.date);

    const fromCode = (CITY_AIR[from] || '').toUpperCase();
    const toCode   = (CITY_AIR[to]   || '').toUpperCase();

    const head = `
      <div class="card-head">
        <div>
          <div class="card-title">${esc(from)} → ${esc(to)}</div>
          <div class="card-note">${type === 'rail' ? '高铁 / 火车'
            : type === 'air' ? '飞机'
            : '火车和飞机都摆好了，自己挑'}</div>
        </div>
        <span class="tag tag-trip">出行</span>
      </div>
      <div class="trip">
        <div class="trip-node">
          <div class="trip-city">${esc(from)}</div>
          <div class="trip-code">${esc(fromCode || '—')}</div>
        </div>
        <div class="trip-line"><span>${esc(d.label)}</span></div>
        <div class="trip-node">
          <div class="trip-city">${esc(to)}</div>
          <div class="trip-code">${esc(toCode || '—')}</div>
        </div>
      </div>
      <div class="trip-meta">
        <span>出发日期 <b>${esc(d.label)}</b></span>
        <span>${d.explicit ? '按你说的' : '默认明天，带上日期可改'}</span>
        ${intent.fromGuessed ? `<span>出发地沿用上次记录，说「从X出发」可改</span>` : ''}
      </div>`;

    /* ---- 火车 ---- */
    let railBlock = '';
    if (type === 'rail' || type === 'both') {
      const url = RAIL_OFFICIAL.url
        .replace('{from}', enc(from)).replace('{to}', enc(to)).replace('{date}', iso);
      const seats = SEAT_GUIDE.map((s) =>
        `<div class="tip"><span class="seat-n">${esc(s.n)}</span><span>${esc(s.d)}</span></div>`).join('');
      const play = RAIL_PLAYBOOK.map((t, i) =>
        `<div class="tip"><span class="tip-n">${i + 1}</span><span>${esc(t)}</span></div>`).join('');

      railBlock = `
        <div class="mini-title">火车票 · 去哪买</div>
        <div class="rows">
          <div class="row row-cheapest">
            <div class="pf pf-12306">铁</div>
            <div class="row-main">
              <div class="row-name">${esc(RAIL_OFFICIAL.name)} <span class="badge badge-best">唯一官方渠道</span></div>
              <div class="row-desc">${esc(RAIL_OFFICIAL.desc)}，已带好出发站、到达站和日期</div>
            </div>
            <div class="row-right">
              <div class="price-na">官方直达</div>
              <a class="go go-brand" href="${url}" target="_blank" rel="noopener noreferrer">去查票</a>
            </div>
          </div>
        </div>
        <div class="mini-title">席别怎么选</div>
        <div class="tips">${seats}</div>
        <div class="mini-title">没票了怎么办</div>
        <div class="tips">${play}</div>
        <div class="banner banner-danger" style="margin-top:10px">
          <span class="banner-ico">!</span>
          <span><strong>第三方「加速包」「专人代抢」一律别买。</strong>12306 从未向任何第三方开放售票接口，
          候补兑现严格按提交先后排队，任何软件都改不了顺序。2026 年中秋国庆开售期间，12306 把 711.7 万笔异常交易丢进慢速队列、
          拒绝出票 133.1 万张——借第三方抢票不仅不会更快，还可能把你的账号一起拖慢。</span>
        </div>`;
    }

    /* ---- 飞机 ---- */
    /* ---- 飞机 ----
       两种形态：
         A. 接了实时报价（/api/flights 有 configured:true）→ 直接给**排好序的航班表**，
            用户不用一个一个点开看价。表格由 renderFlightTable() 渲染。
         B. 没接 → 仍给各平台入口（手动查）。**绝不编价格**。
       这两条路的分岔在渲染时决定不了（要等接口回来），所以先把占位容器放这儿，
       接口回来后用 fillFlights() 把内容填进去。 */
    let airBlock = '';
    if (type === 'air' || type === 'both') {
      const rows = FLIGHT_PLATFORMS.map((p) => {
        const url = p.url
          .replace('{dep}', fromCode.toLowerCase())
          .replace('{arr}', toCode.toLowerCase())
          .replace('{depCity}', enc(from))
          .replace('{arrCity}', enc(to))
          .replace('{date}', iso);
        return `
          <div class="row">
            <div class="pf ${p.cls}">${esc(p.abbr)}</div>
            <div class="row-main">
              <div class="row-name">${esc(p.name)}${p.tag ? ` <span class="badge">${esc(p.tag)}</span>` : ''}</div>
              <div class="row-desc">${esc(p.desc || '')}</div>
            </div>
            <div class="row-right">
              <div class="price-na">实时报价</div>
              <a class="go" href="${url}" target="_blank" rel="noopener noreferrer">查航班</a>
            </div>
          </div>`;
      }).join('');

      airBlock = `
        <div class="mini-title">机票</div>
        <div class="flights" data-flights="${esc(from)}|${esc(to)}|${esc(iso)}">
          <div class="flights-wait">正在查这条航线的实时票价…</div>
        </div>
        <div class="rows flights-manual" hidden>${rows}</div>
        <div class="banner banner-warn" style="margin-top:10px">
          <span class="banner-ico">※</span>
          <span>机票代理报价差得很多，<strong>同一航班不同渠道能差出一顿饭钱</strong>。比完价再看一眼退改签——
          便宜票往往改不起，行程没定死之前别只盯最低价。</span>
        </div>`;
    }

    /* ---- 交通方式取舍：有坐标才算得出来 ---- */
    let modeBlock = '';
    const geoA = CITY_GEO[from], geoB = CITY_GEO[to];
    if (geoA && geoB) {
      const km  = greatCircle(geoA, geoB);
      const est = estimateModes(km);
      const v   = modeVerdict(km);
      const maxT = Math.max(est.rail, est.air);
      const wRail = Math.round((est.rail / maxT) * 100);
      const wAir  = Math.round((est.air  / maxT) * 100);

      const pickLabel = v.pick === 'rail' ? '更适合坐高铁'
                      : v.pick === 'air'  ? '更适合坐飞机'
                      : '两者差不多';

      modeBlock = `
        <div class="mini-title">这条线怎么走更划算</div>
        <div class="cmp">
          <div class="cmp-row">
            <span class="cmp-label">高铁</span>
            <div class="cmp-track"><div class="cmp-fill cmp-fill-rail" style="width:${wRail}%"></div></div>
            <span class="cmp-val">约 ${humanHours(est.rail)}</span>
          </div>
          <div class="cmp-row">
            <span class="cmp-label">飞机</span>
            <div class="cmp-track"><div class="cmp-fill cmp-fill-air" style="width:${wAir}%"></div></div>
            <span class="cmp-val">约 ${humanHours(est.air)}</span>
          </div>
        </div>
        <div class="cmp-verdict">
          <span class="tag tag-trip">${esc(pickLabel)}</span>
          <span>${esc(v.text)}</span>
        </div>
        <div class="banner banner-warn">
          <span class="banner-ico">※</span>
          <span>两地直线距离约 <strong>${Math.round(km)} 公里</strong>（按城市坐标算的大圆距离）。
          上面的耗时是<strong>门到门粗估</strong>：高铁按含停站约 250km/h 再加进出站 0.5 小时；
          飞机按巡航 700km/h 再加往返机场、安检、提前到达共 3 小时。
          只用来看量级，真实时刻以 12306 和航班页面为准。</span>
        </div>`;
    }

    localStorage.setItem('sxm.lastFrom', from);
    return head + modeBlock + railBlock + airBlock;
  }

  /* ======================================================================
     7. 主流程
     ====================================================================== */
  const stream  = $('#stream');
  const input   = $('#input');
  const form    = $('#form');
  const sendBtn = $('.send');

  function scrollDown() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function appendUser(text) {
    const el = document.createElement('section');
    el.className = 'msg msg-user';
    el.innerHTML = `<div class="bubble bubble-user">${esc(text)}</div>`;
    stream.appendChild(el);
    scrollDown();
  }

  function showTyping(label) {
    const el = document.createElement('section');
    el.className = 'msg msg-ai';
    el.innerHTML = `<div class="bubble bubble-ai" style="padding:12px 16px">
        <div class="typing"><i></i><i></i><i></i></div>
        ${label ? `<div class="fine" style="margin-top:2px">${esc(label)}</div>` : ''}
      </div>`;
    stream.appendChild(el);
    scrollDown();
    return el;
  }

  /**
   * 等待态：真的在等外部数据时用骨架屏，其余用打字点。
   * 骨架屏比三个跳动的点诚实——它提前告诉用户"这里会出现一张有几行的卡"，
   * 而不是让界面看起来像在思考。
   */
  function showLoading(opts) {
    const o = opts || {};
    const el = document.createElement('section');
    el.className = 'msg msg-ai';
    el.innerHTML = `<div class="bubble bubble-ai">
        <div class="skeleton">
          <div class="sk-line w60"></div>
          <div class="sk-row"></div>
          <div class="sk-row"></div>
        </div>
        ${o.label ? `<div class="fine" style="margin-top:11px">${esc(o.label)}</div>` : ''}
      </div>`;
    stream.appendChild(el);
    scrollDown();
    return el;
  }

  /**
   * 错态：说清楚发生了什么，并给一个**真的能按**的重试。
   * retryText 传空则不给按钮 —— 有些错（比如"你写了 12 件，最多 8 件"）
   * 重试一百次也还是错，给个假按钮只会让人白点。
   */
  /* ---------- 反问卡：信息不够时该问，不该猜 ----------
     这两张卡都不打接口、不编数据。比起拿「帮我买」当商品名去问平台，
     反问一句是一次对话就解决的事；猜错的代价是脏数据 + 白烧配额。 */
  function renderNeedProduct() {
    return `
      <p class="lead">想买什么？说个名字就行。</p>
      <p class="sub">比如「小米吹风机」「AirPods Pro 3」「猫粮 10kg」。
      有了具体名字我才好去各平台比价 —— 我不会拿「帮我买」这种话去问平台，
      那只会拿回一堆跟你无关的东西。</p>`;
  }

  function renderNeedRoute(cities) {
    const one = (cities || [])[0];
    return `
      <p class="lead">这条路线我还凑不出来。</p>
      <p class="sub">出发地和目的地要写成<strong>两个不同的城市</strong>，比如「北京到上海 下周三」。
      ${one ? '我现在只认出「' + esc(one) + '」。' : ''}</p>`;
  }

  function renderNeedDate(d) {
    const label = (d && d.label) || '这一天';
    return `
      <p class="lead">「${esc(label)}」没有这一天。</p>
      <p class="sub">历法里不存在这个日期，我也不会悄悄换成别的日子（那比报错更坑：你可能照着错的日期去排行程）。
      换个真实日期吧，比如「明天」「下周三」「10 月 1 日」。</p>`;
  }

  function renderError(title, detail, retryText) {    return `
      <div class="state">
        <div class="state-ico">!</div>
        <p class="state-t">${esc(title)}</p>
        <p class="state-d">${esc(detail)}</p>
        ${retryText ? `<button class="retry" type="button" data-retry="1">${esc(retryText)}</button>` : ''}
      </div>`;
  }

  /**
   * @param {string} html
   * @param {string=} retryFor     传了就把「重试」按钮指向这句原始输入
   * @param {boolean=} retryBasket 传 true 则「重试」指向"重算上一次的清单"
   */
  function appendAI(html, retryFor, retryBasket) {
    const el = document.createElement('section');
    el.className = 'msg msg-ai';
    el.innerHTML = `<div class="bubble bubble-ai">${html}</div>`;
    if (retryFor) el.dataset.retryFor = retryFor;
    if (retryBasket) el.dataset.retryBasket = '1';
    stream.appendChild(el);
    // 出行卡里的航班表要先插占位再异步填 —— 界面不卡住，也不会先显示假数据
    if (/data-flights=/.test(html)) fillFlights(el);
    scrollDown();
    return el;
  }

  async function handle(text) {
    let intent = parseIntent(text);

    /* 粘贴了分享链接 / 淘口令：能提取出商品名就走正常比价，
       提取不出（纯链接、纯口令）就给诚实识别卡 —— 不编、不假装解析成功。 */
    const share = parseShareText(text);
    if (share) {
      /* 淘口令周边几乎全是"复制这条信息/打开手机淘宝"这类套话，
         不是商品名 —— 实测把套话送进比价流会出一张垃圾卡。
         所以口令一律给识别卡，引导用户发商品名。 */
      if (share.kind === 'tpwd') { appendAI(renderShareParsed(share)); return; }
      const rest = stripUrlText(text);
      if (share.kind === 'keyword') {
        intent = { type: 'shop', product: share.keyword };
      } else if (rest && rest.length >= 2 && isMeaningfulProduct(rest)) {
        // 链接后面跟的字也得像商品名：实测「链接 + 打开手机淘宝」里的套话
        // 会被当成商品名送进比价流，出一张垃圾卡
        intent = { type: 'shop', product: rest };
      } else {
        appendAI(renderShareParsed(share));
        return;
      }
    }

    if (!intent) return;

    /* 信息不够就反问，不拿套话当商品名去问平台 */
    if (intent.type === 'needProduct') { appendAI(renderNeedProduct()); return; }
    if (intent.type === 'needRoute')   { appendAI(renderNeedRoute(intent.cities)); return; }
    if (intent.type === 'needDate')    { appendAI(renderNeedDate(intent.date)); return; }

    if (intent.type === 'shop') {
      // 先试服务端的真实比价；拿不到就退回手动比价 —— 无论如何都不编数字
      const live = await liveCompare(intent.product);
      if (live) {
        appendAI(renderShopLive(intent.product, live));
        return;
      }

      /* 服务端本来是通的、这次却问不通 —— 必须把这件事说出来。
         静默退回手动比价，用户会以为"这功能本来就这样"，
         而实际上是我们这边坏了。宁可难看，也不要让用户以为成功。 */
      const warn = (SERVER_OK === true && lastLiveError)
        ? '刚才没问通服务端，已退回手动比价。原因：' + lastLiveError
          + '。可以稍后再试一次，或点右上角看「接入状态」。'
        : '';

      // 演示模式：让用户看到真接上之后长什么样，卡片会自己标明「演示数据」
      if (DEMO_MODE) {
        const dd = demoLive(intent.product);
        appendAI(renderShopLive(intent.product, dd));
        return;
      }

      appendAI(renderShop(intent, warn));
      return;
    }
    appendAI(intent.type === 'food' ? renderFood(intent) : renderRoute(intent));
  }

  function ask(text) {
    if (!text) return;
    const intent = parseIntent(text);
    // 没有具体商品名就别转「正在询价」的圈 —— 反问卡是立刻出的，转圈反而像卡住了
    const willQueryServer = !!intent && intent.type === 'shop' && !!intent.product && SERVER_OK !== false;

    saveRecent(text);
    renderRecent();
    appendUser(text);
    sendBtn.disabled = true;
    const loading = willQueryServer
      ? showLoading({ label: '正在向各平台询价…' })
      : showTyping(null);

    setTimeout(async () => {
      try {
        await handle(text);
      } catch (e) {
        // 带上 retryFor，用户点「重试」就是原样再问一次，不用重新打字
        appendAI(renderError('这一步没走通', String((e && e.message) || e)), text);
      } finally {
        loading.remove();
        sendBtn.disabled = false;
        if (input && input.focus) input.focus();
      }
    }, willQueryServer ? 200 : 420);
  }

  /* ======================================================================
     7.4b 最近查询 / 复制结果 / 降价关注
     ----------------------------------------------------------------------
     三件小事共用一个原则：**只存用户真的见过的东西。**
     最近查询存原文；降价关注存自己比出来的价——绝不预填任何"市场价"、
     也绝不根据名字猜一条历史来算"降了多少"，没有记录就没有提醒。
     ====================================================================== */
  const RECENT_KEY = 'sxm.recent';
  const WATCH_KEY  = 'sxm.watch';
  /* 复制文本不再用全局变量：见下面 COPY_STORE 的注释（多卡串文本的真实 bug） */

  function lsGet(k) {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 私密模式存不了就算了 */ }
  }

  /* ---------- 分享链接 / 淘口令识别 ----------
     「把商品拉出来比价」唯一可行的姿势是用户主动粘贴。
     平台的购物车/订单从未对第三方开放（淘宝订单接口个人已禁用），
     我们能做的是把粘贴进来的链接里能提取的东西老老实实提取出来：
     京东 SKU / 拼多多 goods_id / 淘宝 itemId 是公开的 URL 参数；
     淘口令必须走官方邀约制解析接口（权限未批时明说，不假装解析失败）。 */
  function parseShareText(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;

    // 京东商品页：item.jd.com/100012043978.html
    let m = t.match(/item\.jd\.com\/(\d+)\.html/i);
    if (m) return { kind: 'jd-item', id: m[1], platform: 'jd' };

    // 京东搜索链接：search.jd.com/Search?keyword=xxx
    m = t.match(/search\.jd\.com\/[^?]*\?[^#]*keyword=([^&#]+)/i);
    if (m) return { kind: 'keyword', keyword: decodeURIComponent(m[1].replace(/\+/g, ' ')), platform: 'jd' };

    // 拼多多商品：mobile.yangkeduo.com/goods.html?goods_id=xxx
    m = t.match(/yangkeduo\.com\/goods\d*\.html[^#]*[?&]goods_id=(\d+)/i);
    if (m) return { kind: 'pdd-item', id: m[1], platform: 'pdd' };

    // 淘宝 / 天猫商品：detail.tmall.com/item.htm?id=xxx 或 item.taobao.com/item.htm?id=xxx
    m = t.match(/(?:detail\.tmall\.com|item\.taobao\.com)\/item[^#]*[?&]id=(\d+)/i);
    if (m) return { kind: 'tb-item', id: m[1], platform: 'dataoke' };

    // 淘口令：¥xxxx¥ / ₤xxxx₤ / $xxxx$ 这类包裹串（非官方接口解析不了内容，先认出来）
    m = t.match(/[¥₤$]([A-Za-z0-9]{8,})[¥₤$]/);
    if (m) return { kind: 'tpwd', token: m[0], platform: 'dataoke' };

    return null;
  }

  /** 分享识别结果的卡片：能比价的去比价，不能的把「为什么不能」说清楚 */
  function renderShareParsed(parsed) {
    const p = parsed;
    let title = '';
    let body = '';

    if (p.kind === 'keyword') {
      // 搜索链接里带关键词 —— 直接等价于一次商品搜索，走正常比价
      return null;
    }

    if (p.kind === 'jd-item' || p.kind === 'pdd-item' || p.kind === 'tb-item') {
      const platName = p.platform === 'jd' ? '京东' : p.platform === 'pdd' ? '拼多多' : '淘宝 / 天猫';
      title = '识别到' + platName + '商品';
      const url = p.kind === 'jd-item'
        ? 'https://item.jd.com/' + p.id + '.html'
        : p.kind === 'pdd-item'
          ? 'https://mobile.yangkeduo.com/goods.html?goods_id=' + p.id
          : 'https://item.taobao.com/item.htm?id=' + p.id;
      body = `
        <div class="banner banner-info"><span class="banner-ico">i</span>
          <span>已识别商品 ID <code>${esc(p.id)}</code>。同款自动比价要靠联盟接口按 ID 查询
          ——<strong>配上密钥后这一步全自动</strong>；当前没配密钥，先给你直达入口，别让我编个价格。</span></div>
        <div class="rows"><div class="basket-item">
          <div><div class="bi-q">${platName}商品</div>
          <div class="bi-sub">商品 ID：${esc(p.id)}</div></div>
          <div class="bi-right"><a class="go go-brand" href="${esc(url)}"
            target="_blank" rel="noopener noreferrer">打开</a></div>
        </div></div>`;
    } else if (p.kind === 'tpwd') {
      title = '识别到淘口令';
      body = `
        <div class="banner banner-warn"><span class="banner-ico">!</span>
          <span>淘口令的内容要用<strong>淘宝官方邀约制解析接口</strong>才能解开（平台权限收紧，
          普通应用申请不到），所以我<strong>解不开这串口令，也不假装解开了</strong>。
          把商品名字直接发我，马上给你比价；或者点开淘宝看一眼名字再回来。</span></div>`;
    }

    return `
      <div class="card-head">
        <div><div class="card-title">${esc(title)}</div>
        <div class="card-note">从你粘贴的链接里识别</div></div>
        <span class="tag tag-mute">识别</span>
      </div>
      ${body}`;
  }

  /** 粘贴内容里剥掉 URL 后剩下的文字，能当搜索词就用它 */
  function stripUrlText(text) {
    return String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 纯函数：把一条查询插进最近列表（去重置顶、截断）。测试直接打这里。 */
  function dedupeRecent(list, text, max) {
    const cap = max || 8;
    const t = String(text == null ? '' : text).trim();
    if (!t) return (list || []).slice(0, cap);
    return [t].concat((list || []).filter((x) => x !== t)).slice(0, cap);
  }

  function saveRecent(text) {
    lsSet(RECENT_KEY, dedupeRecent(lsGet(RECENT_KEY) || [], text, 8));
  }
  function recentList() { return lsGet(RECENT_KEY) || []; }

  function renderRecent() {
    const box = $('#recent-row');
    if (!box) return;
    const list = recentList();
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = list.map((q) =>
      `<button class="chip chip-recent" type="button" data-recent="${esc(q)}" title="再查一次">${esc(q)}</button>`).join('');
  }

  /* ---------- 降价关注 ---------- */
  function watchList() { return lsGet(WATCH_KEY) || []; }

  /** 纯函数：新增/更新一条关注。同一商品+同一平台算同一条（qKey 归一化比较）。 */
  function upsertWatch(list, entry, max) {
    const cap = max || 10;
    const cur = (list || []).filter((w) => !(w.qKey === entry.qKey && w.platform === entry.platform));
    cur.unshift(entry);
    return cur.slice(0, cap);
  }

  function watchAdd(entry) {
    if (!entry || !entry.q || !entry.platform) return;
    const price = Number(entry.price);
    if (!isFinite(price) || price <= 0) return; // 没有可信价格就不存，"关注"不能建立在假数字上
    lsSet(WATCH_KEY, upsertWatch(watchList(), {
      qKey: String(entry.q).trim().toLowerCase(),
      q: entry.q,
      platform: entry.platform,
      sku: entry.sku || '',
      title: entry.title || '',
      price,
      ts: Date.now(),
    }));
  }

  function watchRemove(qKey, platform) {
    lsSet(WATCH_KEY, watchList().filter((w) => !(w.qKey === qKey && w.platform === platform)));
  }

  /** 纯函数：算降价。没降、同价、数字不可信 → null。宁可没提醒，不给假优惠。 */
  function priceDrop(prev, cur) {
    const p = Number(prev), c = Number(cur);
    if (!isFinite(p) || !isFinite(c) || p <= 0 || c <= 0) return null;
    return c < p ? { saved: Math.round((p - c) * 100) / 100 } : null;
  }

  /* ---------- 关注清单同步码（换设备迁移）----------
     不做账号体系也能把关注带走：导出成一段可复制的码，
     另一台设备粘贴导入。encodeURIComponent 而不是 btoa——
     后者在部分运行环境（vm 桩、老 WebView）不存在，会静默炸掉。 */
  function encodeWatchCode(list) {
    const items = (list || []).map((w) => ({
      q: w.q, platform: w.platform, sku: w.sku || '', title: w.title || '', price: w.price,
      ts: w.ts, // 带上关注时间，导出导入不篡改记录
    }));
    return 'SXM1.' + encodeURIComponent(JSON.stringify(items));
  }

  /** 纯函数：解同步码。格式不对 / 内容非法 → null，绝不把垃圾导进关注列表。 */
  function decodeWatchCode(str) {
    const s = String(str == null ? '' : str).trim();
    if (s.indexOf('SXM1.') !== 0) return null;
    try {
      const arr = JSON.parse(decodeURIComponent(s.slice(5)));
      if (!Array.isArray(arr)) return null;
      const out = [];
      for (const w of arr) {
        if (!w || !w.q || !w.platform) continue;
        const price = Number(w.price);
        if (!isFinite(price) || price <= 0) continue;
        const ts = Number(w.ts);
        out.push({
          qKey: String(w.q).trim().toLowerCase(),
          q: w.q, platform: w.platform, sku: w.sku || '', title: w.title || '',
          price,
          ts: isFinite(ts) && ts > 0 ? ts : Date.now(), // 保留原关注时间，别在迁移中篡改
        });
      }
      return out;
    } catch { return null; }
  }

  /** 导入 = 合并而不是覆盖：本机已有的关注不动，新的加进来（同一商品+平台取导入的价）。 */
  function watchImport(codeStr) {
    const incoming = decodeWatchCode(codeStr);
    if (!incoming) return -1;
    let list = watchList();
    incoming.forEach((w) => { list = upsertWatch(list, w, 10); });
    lsSet(WATCH_KEY, list);
    return incoming.length;
  }

  /* ---------- 复制结果 ---------- */
  /* 复制文本必须**按卡片**存，不能用单一全局变量。
     实测踩过的坑：页面上可以同时躺着好几张卡（查了耳机又查手表），
     全局变量会被后渲染的卡覆盖——点第一张卡的「复制结果」，
     复制到的是最后一张卡的内容。比价卡复制出手表的结果，
     用户会当成耳机的转发出去，这是张冠李戴的错数据，比没这功能更糟。
     做法：渲染时注册一个 id，按钮带上 id，点击按 id 取回自己的那份。 */
  const COPY_STORE = new Map();
  let COPY_SEQ = 0;

  /** 纯函数：只保留最近 keep 条，长会话不无限涨。返回被删掉的 key。 */
  function trimCopyStore(map, keep) {
    const extra = map.size - keep;
    if (extra <= 0) return [];
    const dead = Array.from(map.keys()).slice(0, extra);
    dead.forEach((k) => map.delete(k));
    return dead;
  }

  function registerCopyText(text) {
    const id = String(++COPY_SEQ);
    COPY_STORE.set(id, String(text == null ? '' : text));
    trimCopyStore(COPY_STORE, 60);
    return id;
  }

  /** 纯函数：把实时比价卡压成一段可转发的纯文本。演示数据必须带标注，
      否则复制的假价格被转发出去，比屏幕上的假价格危害更大。 */
  function shopLiveToText(product, data) {
    const d = data || {};
    const lines = ['「' + product + '」比价' + (d.demo ? '（演示数据 · 非实时）' : '')];
    (d.platforms || []).forEach((p) => {
      if (!p.ok || !p.count || !p.lowest) { lines.push(p.name + '：没拿到'); return; }
      lines.push(p.name + '：最低 ¥' + fmtPrice(p.lowest.final) + (p.count > 1 ? '（共 ' + p.count + ' 条）' : ''));
    });
    lines.push('—— 来自「省心买」，比完价下单走平台官方 App');
    return lines.join('\n');
  }

  /** 纯函数：把清单卡压成纯文本。给不出方案时绝不出现总价。 */
  function basketToText(data) {
    const d = data || {};
    const items = d.items || [];
    const lines = ['省钱清单（' + items.length + ' 件）' + (d.demo ? '（演示数据 · 非实时）' : '')];
    if (d.recommend === 'none') {
      lines.push('暂时给不出方案：' + (d.reason || ''));
      items.forEach((it) => { if (!it.best) lines.push('· ' + it.q + '：没拿到价'); });
    } else {
      lines.push('结论：' + (d.reason || ''));
      ((d.split && d.split.platforms) || []).forEach((p) => {
        lines.push('· 分件买：' + p.name + ' ¥' + fmtPrice(p.subtotal));
      });
      items.forEach((it) => {
        if (it.best) lines.push('· ' + it.q + ' → ' + it.best.name + ' ¥' + fmtPrice(it.best.final));
      });
      if (d.split && d.split.total) lines.push('分件买合计：¥' + fmtPrice(d.split.total));
      if (d.bestSingle && d.bestSingle.name) {
        lines.push('一家买齐（' + d.bestSingle.name + '）：¥' + fmtPrice(d.bestSingle.total));
      }
    }
    lines.push('—— 来自「省心买」');
    return lines.join('\n');
  }

  /** 纯函数：比价分享深链。收到链接的人打开即自动比价 —— 这是网页对小程序的天然优势。 */
  function shareUrl(product, demo) {
    const base = (typeof location !== 'undefined' && location.origin && String(location.origin).indexOf('http') === 0)
      ? location.origin + (location.pathname || '/')
      : '/';
    return base + (demo ? '?demo=1&q=' : '?q=') + enc(String(product == null ? '' : product).trim());
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { if (t.remove) t.remove(); }, 1800);
  }

  /* 剪贴板 API 有个真实的坑：在某些环境（自动化、部分 WebView）它不 reject
     而是**永远挂起**——实测点按钮后 700ms 都没有回调，用户得不到任何反馈。
     所以给它一个短超时：到点就当失败，走 execCommand 兜底，最后必有 toast。 */
  function withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard timeout')), ms)),
    ]);
  }

  async function copyText(text) {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await withTimeout(navigator.clipboard.writeText(text), 1200);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      /* file:// 或旧 WebView：execCommand 兜底。再不行就明说，让用户长按复制。 */
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        if (ta.remove) ta.remove();
      } catch { ok = false; }
    }
    showToast(ok ? '已复制' : '复制失败，长按文字手动复制');
  }

  /* ======================================================================
     7.5 服务端探测
     ----------------------------------------------------------------------
     SERVER_OK 三态：null 没探过 / true 可用 / false 不可用。
     用 file:// 直接打开时 fetch 会失败，自动落到手动比价模式，不需要额外判断。
     ====================================================================== */
  let SERVER_OK = null;
  /* 上一次实时比价失败的原因。为空表示"没有失败"，
     注意"没配密钥"不算失败 —— 那是预期状态，不该弹错误提示。 */
  let lastLiveError = '';

  /* 服务端权威的「已实现数据源」集合。null = 还没探测到（纯前端模式）。 */
  let HEALTH_IDS = null;
  let HEALTH_LIMITS = null;

  async function probeHealth() {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) { SERVER_OK = false; return; }
      const h = await res.json();
      if (!h.ok || !Array.isArray(h.adapters)) { SERVER_OK = false; return; }
      SERVER_OK = true;
      /* 服务端的 adapters 列表 = **真的实现了的数据源**。
         记成集合，抽屉据此区分「配 key 就能用」和「配了也没用」。
         踩过的坑：以前这里只回填 live，抽屉就把所有没配 key 的都写成
         "未接入"，等于向用户承诺了一些后端压根没有的数据源。 */
      HEALTH_IDS = new Set(h.adapters.map((a) => a.id));
      HEALTH_LIMITS = (h.limits && typeof h.limits === 'object') ? h.limits : null;
      h.adapters.forEach((a) => {
        const t = ADAPTER_REGISTRY.find((x) => x.id === a.id);
        if (t) t.live = !!a.configured;
      });
      refreshDot();
      renderDrawer();
    } catch {
      SERVER_OK = false;
    }
  }

  /**
   * 这个数据源当前版本到底实现了没有？
   * - 有服务端：以 /api/health 为准（唯一事实来源）。
   * - 纯前端：只能信目录里的 planned 标注（keys 在服务端，前端无论如何都配不了）。
   * 返回 true / false / null（null = 现在还判断不了）。
   */
  function sourceImplemented(a) {
    if (HEALTH_IDS) return HEALTH_IDS.has(a.id);
    if (SERVER_OK === false) return !a.planned;
    return null;
  }

  async function liveCompare(q) {
    lastLiveError = '';
    if (SERVER_OK === false) return null;
    try {
      const res = await fetch('/api/compare?q=' + encodeURIComponent(q),
        { signal: AbortSignal.timeout(12000) });
      if (!res.ok) {
        // 优先用服务端给的结构化错误（它有 code 和给人看的话）
        const body = await res.json().catch(() => null);
        lastLiveError = (body && body.error && body.error.message) || ('服务端返回 HTTP ' + res.status);
        if (SERVER_OK !== true) SERVER_OK = false;
        return null;
      }
      const data = await res.json();
      if (!data || !data.ok) {
        lastLiveError = (data && data.error && data.error.message) || '服务端返回了不完整的结果';
        return null;
      }
      SERVER_OK = true;
      /* 一个平台都没配密钥 → 这不是错误，是预期状态。
         不留一张空卡，退回去给可用的手动比价，而且不能报错吓用户。 */
      if (!Array.isArray(data.platforms) || data.platforms.length === 0) return null;
      return data;
    } catch (e) {
      lastLiveError = (typeof navigator !== 'undefined' && navigator && navigator.onLine === false)
        ? '当前设备没有联网'
        : String((e && e.message) || e);
      if (SERVER_OK !== true) SERVER_OK = false;
      return null;
    }
  }

  /**
   * 查一条航线的实时票价。
   * 返回 null 表示「拿不到」—— 调用方据此退回手动查入口，**不编价格**。
   */
  async function liveFlights(from, to, date) {
    lastLiveError = '';
    if (SERVER_OK === false) return null;
    const f = CITY_AIR[from];
    const t = CITY_AIR[to];
    // 没有三字码就查不了 —— 这也是「拿不到」的一种，如实退回手动
    if (!f || !t) return null;
    try {
      const qs = 'from=' + encodeURIComponent(f.toUpperCase())
               + '&to='   + encodeURIComponent(t.toUpperCase())
               + '&date=' + encodeURIComponent(date)
               + '&market=CN';
      const res = await fetch('/api/flights?' + qs, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        lastLiveError = (body && body.error && body.error.message) || ('服务端返回 HTTP ' + res.status);
        return null;
      }
      const data = await res.json();
      if (!data || !data.ok) {
        lastLiveError = (data && data.error && data.error.message) || '服务端返回了不完整的结果';
        return null;
      }
      SERVER_OK = true;
      // 没接密钥 / 没查到航班 —— 都不是错误，退回手动入口即可，别吓用户
      if (!data.configured || !Array.isArray(data.flights) || !data.flights.length) {
        flightsNote = data.note || '';
        return null;
      }
      return data;
    } catch (e) {
      lastLiveError = (typeof navigator !== 'undefined' && navigator && navigator.onLine === false)
        ? '当前设备没有联网'
        : String((e && e.message) || e);
      return null;
    }
  }

  /** 分钟 →「2小时15分」 */
  function humanMin2(min) {
    const m = Number(min) || 0;
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? h + '小时' + (r ? r + '分' : '') : r + '分';
  }

  /**
   * 航班表：**按价格从低到高排好**，一行一个航班，价格直接写在行里。
   * 用户要的就是这个 —— 不用一个一个点开看价。
   */
  function renderFlightTable(data) {
    /* 渲染层**自己再排一次**，不假设上游一定排好了。
       为什么不用"服务端已经排过"来说服自己：端到端验过，服务端排序一旦失效
       （或将来换成别的数据源、或有人改坏了 sortByPrice），表格会安静地乱序 ——
       而「自动排好序」正是这个功能对用户的全部承诺。排序成本近乎零，两处都排。 */
    const list = (data.flights || [])
      .slice()
      .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0))
      .slice(0, 12);
    const cheapest = list[0] ? list[0].price : null;

    const rows = list.map((f, i) => {
      const isBest = i === 0;
      const bags = f.bags
        ? '行李 ' + (f.bags.carry_on || 0) + ' 手提' + (f.bags.checked ? ' + ' + f.bags.checked + ' 托运' : '')
        : '';
      const meta = [
        esc(f.stopsText),
        humanMin2(f.durationMin) ? '约 ' + humanMin2(f.durationMin) : '',
        bags,
        f.selfTransfer ? '需自行转机' : ''
      ].filter(Boolean).join(' · ');

      return `
        <div class="fl-row${isBest ? ' fl-best' : ''}">
          <div class="fl-time">
            <div class="fl-hm">${esc(f.depTime || '—')}</div>
            <div class="fl-port">${esc(f.depAirport || '')}</div>
          </div>
          <div class="fl-mid">
            <div class="fl-arrow">→</div>
            <div class="fl-meta">${esc(meta)}</div>
          </div>
          <div class="fl-time fl-time-arr">
            <div class="fl-hm">${esc(f.arrTime || '—')}</div>
            <div class="fl-port">${esc(f.arrAirport || '')}</div>
          </div>
          <div class="fl-main">
            <div class="fl-carrier">${esc(f.carrier)}${f.flightNo ? ' ' + esc(f.flightNo) : ''}</div>
            ${isBest ? '<div class="fl-tag">最便宜</div>' : ''}
          </div>
          <div class="fl-price">
            <div class="fl-amount">${esc(f.symbol || '¥')}${Math.round(f.price)}</div>
            <div class="fl-unit">起</div>
          </div>
        </div>`;
    }).join('');

    const when = data.at ? fmtClock(data.at) : '';
    return `
      <div class="fl-head">
        <span>共 ${data.count || list.length} 个航班，<strong>已按价格从低到高排好</strong></span>
        ${when ? `<span class="fl-at">查于 ${esc(when)}</span>` : ''}
      </div>
      <div class="fl-list">${rows}</div>
      <div class="banner banner-warn" style="margin-top:8px">
        <span class="banner-ico">※</span>
        <span>价格是<strong>查询时刻的实时报价</strong>，会随余票和舱位变动；「起」表示该航班最低舱位。
        点右侧链接进官方页面看最终价与退改签规则 —— 便宜票往往改不起。</span>
      </div>`;
  }

  /* 航班接口的说明文字（拿不到时用），和「最近一次错误」分开存 */
  let flightsNote = '';

  /**
   * 页面渲染后，把占位容器换成真实航班表。
   * 拿不到就展开「手动查」入口，并把原因说清楚（静默失败是 bug）。
   */
  function fillFlights(root) {
    const box = root && root.querySelector ? root.querySelector('.flights[data-flights]') : null;
    if (!box) return;
    const [from, to, iso] = String(box.getAttribute('data-flights') || '').split('|');
    if (!from || !to || !iso) return;

    const manual = root.querySelector('.flights-manual');

    liveFlights(from, to, iso).then((data) => {
      if (data) {
        box.innerHTML = renderFlightTable(data);
        return;
      }
      // 拿不到 → 摆手动入口。绝不填假数字。
      /* 原因要分清楚，别一律说"未接入"：
         - 纯前端模式：压根没有 /api/flights 可问，配不配密钥都无关；
         - 有服务端但没配密钥：那才叫"未接入"，配上就能用。
         把这两句混成一句，用户会以为自己配错东西了。 */
      const reason = SERVER_OK === false
        ? '当前是纯前端模式（没有服务端），机票实时报价需要一个跑起来的服务端'
        : (flightsNote || lastLiveError || '机票实时报价未接入');
      box.innerHTML = `
        <div class="flights-na">
          <div class="flights-na-t">这条航线暂时拿不到实时报价</div>
          <div class="flights-na-d">${esc(reason)}
          —— 下面给你各平台的直查入口，点进去看的就是实时价。</div>
        </div>`;
      if (manual) manual.hidden = false;
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ask(text);
  });

  document.addEventListener('click', (e) => {
    /* 顺序有讲究：先判 data-open，再判 .chip / .cap。
       反过来的话，带 data-open 的 chip（省钱清单）会被 .chip 分支吃掉，
       只往输入框里填一段空文本，什么都不发生。 */
    const opener = e.target.closest('[data-open]');
    if (opener) { openPanel(opener.dataset.open); return; }

    /* 必须用 .theme-chip 而不是 [data-theme]：
       applyTheme 会把 data-theme 写到 <html> 上（CSS 暗色选择器依赖它），
       closest 会冒泡命中 <html>，导致页面任意点击都被当成主题切换——
       深色系统下用户从深色往回循环永远回不到「自动」。实测踩过这个坑。 */
    const themePick = e.target.closest('.theme-chip');
    if (themePick) { setTheme(themePick.dataset.theme); return; }

    /* 这几个分支必须在 .chip 之前：它们很多就长在 chip 上，
       被 .chip 的"只填输入框"分支吃掉就什么都发生了。 */
    const recentChip = e.target.closest('[data-recent]');
    if (recentChip) { closeBasket(); ask(recentChip.dataset.recent); return; }

    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      // 按 id 取这张卡自己的文本：页面上多张卡并存也不会张冠李戴
      const text = COPY_STORE.get(copyBtn.dataset.copy);
      if (text) copyText(text);
      else showToast('这条结果已经过期，重新查一次再复制');
      return;
    }

    /* 分享深链：比价结果本身就是一个链接，打开自动比 —— 不需要小程序的分享模板 */
    const shareBtn = e.target.closest('[data-share]');
    if (shareBtn) {
      copyText(shareUrl(shareBtn.dataset.share, shareBtn.dataset.shareDemo === '1'));
      return;
    }

    const watchBtn = e.target.closest('[data-watch]');
    if (watchBtn) {
      const ds = watchBtn.dataset;
      watchAdd({ q: ds.q, platform: ds.platform, sku: ds.sku, title: ds.title, price: ds.price });
      showToast('已关注「' + ds.q + '」，下次比价发现降价会提醒你');
      return;
    }

    const watchDel = e.target.closest('[data-watch-remove]');
    if (watchDel) {
      watchRemove(String(watchDel.dataset.q).trim().toLowerCase(), watchDel.dataset.platform);
      renderDrawer();
      return;
    }

    /* 关注清单同步码：导出即复制；导入展开文本域，点「导入」才真正写入 */
    if (e.target.closest('[data-watch-export]')) {
      if (!watchList().length) { showToast('还没有关注任何商品'); return; }
      copyText(encodeWatchCode(watchList()));
      return;
    }
    if (e.target.closest('[data-watch-import]')) {
      const box = $('#watch-import-box');
      const go = $('#watch-import-go');
      if (box) { box.hidden = false; box.value = ''; }
      if (go) go.hidden = false;
      if (box && box.focus) box.focus();
      return;
    }
    if (e.target.closest('#watch-import-go')) {
      const box = $('#watch-import-box');
      const n = box ? watchImport(box.value) : -1;
      if (n < 0) showToast('同步码无效，检查是否完整复制');
      else if (n === 0) showToast('同步码里没有有效的关注记录');
      else showToast('已导入 ' + n + ' 条关注');
      renderDrawer();
      return;
    }

    const chip = e.target.closest('.chip');
    if (chip && chip.dataset.fill) { input.value = chip.dataset.fill; input.focus(); return; }

    const cap = e.target.closest('.cap');
    if (cap && cap.dataset.demo) { ask(cap.dataset.demo); return; }

    const retry = e.target.closest('[data-retry]');
    if (retry) {
      const msg = retry.closest('.msg');
      const ds = (msg && msg.dataset) || {};
      if (msg && msg.remove) msg.remove();
      if (ds.retryFor) { ask(ds.retryFor); return; }
      if (ds.retryBasket && LAST_BASKET.length) { runBasket(LAST_BASKET.slice()); return; }
      return;
    }
  });

  /* ======================================================================
     7.6 省钱清单面板
     ----------------------------------------------------------------------
     输入用表单、输出用对话卡。
     为什么不做成"从一句话里自动认出购物清单"：
       中文里"、""和"顿号既可能分隔商品也可能就是商品名的一部分
       （"买北京烤鸭和天津麻花"这种），猜错一次用户就再也不会用了。
       清单是结构化任务，就给结构化的输入。
     ====================================================================== */
  const BASKET_MAX = 8;
  const basketEl   = $('#basket');
  const basketMask = $('#basket-mask');
  const basketTa   = $('#basket-text');
  let LAST_BASKET  = [];

  /** 把清单文本切成商品列表。抽成纯函数是为了能直接测分隔符的边界 */
  function splitBasketInput(text) {
    return String(text == null ? '' : text)
      .split(/[\n,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function basketQueryList() {
    return basketTa ? splitBasketInput(basketTa.value) : [];
  }

  function syncBasketCount() {
    const el = $('#basket-count');
    if (!el) return;
    const n = basketQueryList().length;
    el.textContent = n + ' 件' + (n > BASKET_MAX ? '（最多 ' + BASKET_MAX + ' 件）' : '');
    el.style.color = n > BASKET_MAX ? 'var(--brand-ink)' : '';
  }

  function openPanel(name) {
    if (name === 'basket') openBasket();
    else openDrawer();
  }

  function openBasket() {
    closeDrawer();
    syncBasketCount();
    if (basketEl) basketEl.classList.add('open');
    if (basketMask) basketMask.classList.add('open');
    focusInto(basketEl);                    // 锁住主内容（焦点随后交给输入框）
    // 等抽屉滑进来再聚焦，否则手机上键盘会弹在半路，动画会卡
    if (basketTa && basketTa.focus) setTimeout(() => { try { basketTa.focus(); } catch { /* 忽略 */ } }, 260);
  }

  function closeBasket() {
    if (basketEl) basketEl.classList.remove('open');
    if (basketMask) basketMask.classList.remove('open');
    restoreFocus();
  }

  async function runBasket(items) {
    LAST_BASKET = items.slice();
    appendUser('省钱清单（' + items.length + ' 件）：' + items.join('、'));

    const go = $('#basket-go');
    if (go) go.disabled = true;
    const loading = showLoading({ label: '逐件询价中（' + items.length + ' 件，要问 ' + items.length + ' 轮）…' });

    try {
      if (SERVER_OK === false) {
        loading.remove();
        appendAI(renderBasketOffline(items));
        return;
      }

      const qs = items.map((x) => 'q=' + encodeURIComponent(x)).join('&');
      const res = await fetch('/api/basket?' + qs, { signal: AbortSignal.timeout(25000) });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error((data && data.error && data.error.message) || ('服务端返回 HTTP ' + res.status));
      }
      if (!data || !data.ok) throw new Error('服务端返回了不完整的结果');
      SERVER_OK = true;

      loading.remove();
      appendAI(renderBasket(data));
    } catch (e) {
      loading.remove();
      appendAI(renderError('清单没算出来', String((e && e.message) || e), '重新算一次'), null, true);
    } finally {
      if (go) go.disabled = false;
    }
  }

  function submitBasket() {
    const items = basketQueryList();

    if (!items.length) {
      appendAI(renderError('清单是空的', '一行写一件商品，我就逐件比价，再算该分几家买。'));
      return;
    }
    if (items.length > BASKET_MAX) {
      // 超限时把话说清楚，而不是悄悄只算前 8 件 —— 用户会以为剩下那些也算过了
      appendAI(renderError('一次最多 ' + BASKET_MAX + ' 件',
        '你写了 ' + items.length + ' 件。每件都要打一轮平台接口，一次问太多既慢又容易被平台限流。先算最想买的那几件。'));
      return;
    }
    closeBasket();
    runBasket(items);
  }

  if (basketTa) {
    basketTa.addEventListener('input', syncBasketCount);
    basketTa.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitBasket(); }
    });
  }
  if ($('#basket-go')) $('#basket-go').addEventListener('click', submitBasket);
  if ($('#basket-close')) $('#basket-close').addEventListener('click', closeBasket);
  if (basketMask) basketMask.addEventListener('click', closeBasket);
  if ($('#btn-theme')) $('#btn-theme').addEventListener('click', cycleTheme);

  /* ======================================================================
     8. 接入状态抽屉
     ====================================================================== */
  const drawer = $('#drawer');
  const mask   = $('#drawer-mask');

  /* ---------- 抽屉的无障碍：inert + 焦点管理 ----------
     为什么必须有：两个抽屉只是**视觉上**盖住了页面（靠 .open 加遮罩），
     底层内容在无障碍树里依然可聚焦 —— 按 Tab 会走到被盖住的 chips 上，
     键盘/读屏用户等于"点到了自己看不见的东西"。
     用原生 inert 一句话锁住主内容，比手写 focus trap 更不容易漏。
     另外：关抽屉时把焦点还给当初打开它的那个按钮，否则焦点会掉到 body，
     键盘用户得从头 Tab 一遍。 */
  const appRoot = document.querySelector('.app');
  let drawerLastFocus = null;

  /** 只要有抽屉开着，就锁住主内容。两个抽屉共用一个入口，避免各自漏判 */
  function syncInert() {
    const anyOpen = (drawer && drawer.classList.contains('open'))
                 || (basketEl && basketEl.classList.contains('open'));
    if (appRoot) appRoot.inert = !!anyOpen;
  }

  /** 打开抽屉的统一处理：记住来源焦点 → 锁住主内容 → 把焦点移进抽屉 */
  function focusInto(el) {
    drawerLastFocus = document.activeElement || null;
    syncInert();
    if (!el || !el.querySelector) return;
    const first = el.querySelector('button, [href], input, textarea, select');
    if (first && first.focus) { try { first.focus(); } catch { /* 忽略 */ } }
  }

  /** 关闭后解冻主内容，并把焦点还给触发元素（还在文档里才还） */
  function restoreFocus() {
    syncInert();
    const el = drawerLastFocus;
    drawerLastFocus = null;
    if (!el || !el.focus) return;
    try {
      // 元素可能已被重渲染移除 —— 对已脱离文档的节点调 focus 没有意义
      if (typeof document.contains !== 'function' || document.contains(el)) el.focus();
    } catch { /* 忽略 */ }
  }

  /**
   * 一个数据源在抽屉里该显示成什么。抽成纯函数是为了**能被测试直接打到** ——
   * 否则只能去断言拼接后的 HTML 字符串，很容易写出一条"恒真"的假断言。
   * 返回 { tag, ico, icoBg, tagCls, text }。
   */
  function adapterStatus(a) {
    const impl = sourceImplemented(a);
    if (a.live) {
      return { tag: '已接入', ico: '✓', icoBg: '#12A150', tagCls: 'tag-ok',
               text: '密钥已配置，比价会走这个平台' };
    }
    if (impl === false) {
      return { tag: '规划中', ico: '·', icoBg: '#C6CDD8', tagCls: 'tag-mute',
               text: '当前版本未实现，配了 key 也不会生效' };
    }
    if (impl === true) {
      return { tag: '未接入', ico: '—', icoBg: '#98A2B3', tagCls: 'tag-mute',
               text: '还没配密钥，配上就能用' };
    }
    return { tag: '未接入', ico: '?', icoBg: '#98A2B3', tagCls: 'tag-mute',
             text: '需服务端才能接入（当前是纯前端模式）' };
  }

  function renderDrawer() {
    const live = ADAPTER_REGISTRY.filter((a) => a.live).length;
    const plannedCount = ADAPTER_REGISTRY.filter((a) => sourceImplemented(a) === false).length;

    /* 三态，而不是"接入/未接入"两态。
       以前所有没配 key 的都写"未接入 · 配 XXX"，等于向用户承诺
       「配上就能用」—— 可 haodanku / meituan / ctrip 后端压根没有 adapter，
       配了也是白配。这是**会让人白花时间**的那种谎，必须分开说。 */
    const rows = ADAPTER_REGISTRY.map((a) => {
      const s = adapterStatus(a);
      return `
      <div class="plat-row">
        <div class="pf" style="background:${s.icoBg}">${s.ico}</div>
        <div class="row-main">
          <div class="row-name">${esc(a.name)}</div>
          <div class="row-desc">${esc(a.scope)} · ${esc(a.person)}</div>
          <div class="row-desc mono">${esc(a.env)}</div>
          <div class="row-desc">${esc(s.text)}</div>
        </div>
        <div class="row-right">
          <span class="tag ${s.tagCls}">${s.tag}</span>
        </div>
      </div>`;
    }).join('');

    const serverLine = SERVER_OK === true
      ? '<span class="tag tag-ok">服务端已连接</span>'
      : SERVER_OK === false
        ? '<span class="tag tag-mute">纯前端模式</span>'
        : '<span class="tag tag-mute">探测中</span>';

    const serverNote = SERVER_OK === false
      ? '没有连上 <code>/api/compare</code>，所以比价走「手动比价」——把各平台搜索页一次摆好。<br>启动服务端后（<code>node server/server.js</code>）会自动切换成真实比价。'
      : '';

    /* 降价关注的管理入口放这里而不是顶栏：它和接入状态一样，是低频动作 */
    const wl = watchList();
    const watchBlock = wl.length ? `
      <div class="mini-title" style="margin-top:16px">降价关注（${wl.length}/10）</div>
      ${wl.map((w) => `
        <div class="plat-row watch-row">
          <div class="row-main">
            <div class="row-name">${esc(w.q)}</div>
            <div class="row-desc">${esc(platLabel(w.platform))} · 关注时最低 ¥${fmtPrice(w.price)}</div>
          </div>
          <div class="row-right">
            <button class="ghost-btn" type="button"
              data-watch-remove="1" data-q="${esc(w.qKey)}" data-platform="${esc(w.platform)}">删除</button>
          </div>
        </div>`).join('')}
      <div class="fine" style="margin:8px 0 0">下次比价时发现降价，会在结果卡顶部提醒你。提醒一次后记录更新为当前价，再降再提。</div>` : '';

    /* 换设备迁移：导出/导入同步码。没有关注时只给导入，别给一个复制空列表的按钮。 */
    const syncBlock = `
      <div class="watch-sync" style="display:flex;gap:8px;margin-top:10px">
        ${wl.length ? '<button class="ghost-btn" type="button" data-watch-export="1">导出同步码</button>' : ''}
        <button class="ghost-btn" type="button" data-watch-import="1">导入同步码</button>
      </div>
      <textarea id="watch-import-box" class="watch-import" rows="3" hidden
        placeholder="把另一台设备导出的同步码整段粘到这里"></textarea>
      <button id="watch-import-go" class="retry" type="button" hidden style="margin-top:8px">导入</button>`;

    /* 服务端统计：让 /api/metrics 有一个用户可见的出口。
       拿不到就不显示这块 —— 缺一块信息好过显示一条假数据。 */
    let metricsBlock = '';
    if (SERVER_OK === true && METRICS) {
      const m = METRICS;
      const platRows = (m.platforms || []).map((p) => `
        <div class="watch-row" style="display:flex;justify-content:space-between;padding:3px 0">
          <span>${esc(platLabel(p.id))}</span>
          <span class="fine">${p.calls} 次 · 成功 ${Math.round((p.successRate || 0) * 100)}% · 均 ${p.avgMs}ms</span>
        </div>`).join('');
      metricsBlock = `
        <div class="mini-title" style="margin-top:16px">服务端统计（本进程）</div>
        <div class="watch-row fine" style="line-height:1.9">
          请求 ${m.requests || 0} 次 · 错误 ${m.errors || 0} · 被限流 ${m.rateLimited || 0} · 平均 ${m.avgMs || 0}ms
          ${platRows}
        </div>`;
    }

    /* 主题放抽屉里而不是顶栏：它是"设置"，不是主要动作。
       默认「自动」的人根本不需要碰它，把它顶到顶栏只会占掉手机上的位置。 */
    const themeBlock = `
      <div class="switch-row" style="display:block">
        <div style="font-size:13px;font-weight:600;margin-bottom:9px">主题</div>
        <div style="display:flex;gap:6px">
          ${THEMES.map((t) => `<button class="chip theme-chip" type="button" data-theme="${t}" style="${
            t === THEME ? 'border-color:#FFC6B6;background:var(--brand-soft);color:var(--brand-ink);font-weight:600' : ''
          }">${THEME_LABEL[t]}</button>`).join('')}
        </div>
        <div class="fine" style="margin-top:9px">「自动」跟随系统。首帧就已经是正确颜色，不会白屏闪一下。</div>
      </div>`;

    $('#drawer-body').innerHTML = `
      <div class="banner banner-${live ? 'info' : 'warn'}">
        <span class="banner-ico">${live ? 'i' : '!'}</span>
        <span style="display:block">
          ${serverLine}
          <div style="margin-top:6px">${live
            ? `已检测到 <strong>${live}</strong> 个数据源，比价会走真实接口。`
            : '当前 <strong>0 个</strong>数据源接入。比价会退化成「手动比价」——帮你把各平台搜索页一次摆好，<strong>不编价格</strong>。'}</div>
          ${serverNote}
        </span>
      </div>
      ${themeBlock}
      <label class="switch-row">
        <input type="checkbox" id="demo-toggle" ${DEMO_MODE ? 'checked' : ''}>
        <span>预览接入后的比价效果<em>（样例数字，非实时）</em></span>
      </label>
      ${watchBlock}
      ${syncBlock}
      ${metricsBlock}
      ${rows}
      ${plannedCount ? `<div class="fine" style="margin-top:10px">标着「规划中」的 ${plannedCount} 个，当前版本后端还没有对应实现 —— 现在配 key 也不会生效，别白折腾。等实现了我会在这里改成「未接入 · 配上就能用」。</div>` : ''}`;
  }

  let METRICS = null;
  async function loadMetrics() {
    try {
      const res = await fetch('/api/metrics', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return;
      const m = await res.json();
      if (!m || !m.ok) return;
      METRICS = m;
      /* 抽屉还开着才重渲染，避免用户已关抽屉后的异步结果把无关状态刷掉 */
      if (drawer.classList.contains('open')) renderDrawer();
    } catch { /* 指标拿不到不影响主功能，静默 */ }
  }

  function platLabel(id) {
    const t = ADAPTER_REGISTRY.find((x) => x.id === id);
    return t ? t.name : (SHOP_PLATFORMS.find((x) => x.id === id) || {}).name || id;
  }

  function openDrawer()  {
    renderDrawer();
    drawer.classList.add('open'); mask.classList.add('open');
    focusInto(drawer);                      // 锁住主内容 + 焦点移进抽屉
    if (SERVER_OK === true) loadMetrics(); // 异步到了再刷新抽屉
  }
  function closeDrawer() {
    drawer.classList.remove('open'); mask.classList.remove('open');
    restoreFocus();
  }

  if ($('#btn-status')) $('#btn-status').addEventListener('click', openDrawer);
  if ($('#btn-close')) $('#btn-close').addEventListener('click', closeDrawer);
  mask.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDrawer(); closeBasket(); }
  });

  drawer.addEventListener('change', (e) => {
    if (e.target.id !== 'demo-toggle') return;
    DEMO_MODE = e.target.checked;
    closeDrawer();
    appendAI(DEMO_MODE
      ? `<p class="lead">效果预览已打开。</p>
         <p class="sub">现在随便问一件商品，价格会被拉进一张表横着比。再强调一次：<strong>那串数字是样例，不是报价。</strong>
         真实价格要等联盟密钥配好。</p>`
      : `<p class="lead">效果预览已关闭，回到手动比价模式。</p>
         <p class="sub">这个模式下每个入口都是真的，点开就是实时搜索结果。</p>`);
  });

  function refreshDot() {
    $('#status-dot').className = 'dot' + (ADAPTER_REGISTRY.some((a) => a.live) ? ' live' : '');
  }

  /* ======================================================================
     8.9 网页版独有能力：安装到桌面 + 语音输入
     ====================================================================== */
  /* 安装到桌面：Chromium 系浏览器在页面满足 PWA 条件后才派发 beforeinstallprompt。
     按钮平时藏着——事件没来就说明当前环境装不了（比如 iOS Safari 要走
     分享菜单里的「添加到主屏幕」），绝不给一个点了没反应的死按钮。 */
  let installEvt = null;
  const installBtn = $('#btn-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    if (installBtn) installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installEvt = null;
    if (installBtn) installBtn.hidden = true;
    showToast('已装到桌面，下次点图标直接进');
  });
  if (installBtn) installBtn.addEventListener('click', async () => {
    if (!installEvt) return;
    const evt = installEvt;
    installEvt = null;
    installBtn.hidden = true; // 事件只能消费一次，先收按钮再试 prompt——受限环境里 prompt 会直接抛，别把收起动作也搭进去
    try { evt.prompt(); } catch { return; }
    try { await evt.userChoice; } catch { /* 用户关掉了确认框 */ }
  });

  /* 语音输入：Web Speech API。支持的浏览器才露出麦克风按钮；
     没听清、权限被拒都给 toast，不静默失败。识别完直接替用户发问，
     因为这个输入框的使命就是「说一句话，出结果」。 */
  const SRClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = $('#btn-mic');
  if (SRClass && micBtn) {
    micBtn.hidden = false;
    let listening = false;
    let rec = null;
    let watchDog = null;
    let gotText = false, errored = false, cancelled = false;
    const finish = () => {
      if (watchDog) { clearTimeout(watchDog); watchDog = null; }
      listening = false;
      micBtn.classList.remove('listening');
    };
    micBtn.addEventListener('click', () => {
      if (listening) { cancelled = true; try { rec && rec.stop(); } catch { /* 已停就算了 */ } return; }
      rec = new SRClass();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      gotText = false; errored = false; cancelled = false;
      listening = true;
      micBtn.classList.add('listening');
      /* 看门狗：有些环境（无头浏览器、部分 WebView）识别会静默卡死——
         不报错、不结束，按钮永远停在「听诊中」。10 秒没结果就强制收场。 */
      watchDog = setTimeout(() => {
        const stuck = listening;
        cancelled = true; // 看门狗收场后 onend 若再触发，别再叠一条「没听清」
        finish();
        try { rec && rec.stop(); } catch { /* 忽略 */ }
        if (stuck) showToast('没听到内容，再试一次或直接打字');
      }, 10000);
      rec.onresult = (ev) => {
        const text = ((ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript) || '').trim();
        if (!text) return;
        gotText = true;
        finish();
        input.value = text;
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      };
      rec.onerror = (ev) => {
        errored = true;
        finish();
        showToast(ev && ev.error === 'not-allowed'
          ? '麦克风权限被拒了，在浏览器地址栏可以重新允许'
          : '没听清，再试一次');
      };
      rec.onend = () => {
        /* 静默结束：既没结果也没报错（无头环境实测会出现）。
           用户点完麦克风什么都得不到 = 按钮坏了的错觉，必须给一句话。 */
        const silent = !gotText && !errored && !cancelled;
        finish();
        if (silent) showToast('没听清，再试一次');
      };
      try { rec.start(); } catch {
        finish();
        showToast('这个浏览器没能启动语音识别，直接打字也一样');
      }
    });
  }

  /* ======================================================================
     9. 初始化
     ====================================================================== */
  THEME = (function () {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(v) >= 0 ? v : 'auto';
    } catch { return 'auto'; }
  })();

  /* 系统切换明暗时，只有「自动」模式下才跟着变。
     用户手动选过浅色，系统再切到深色也不该把他拽走 —— 那叫覆盖用户的选择。 */
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', () => { if (THEME === 'auto') applyTheme(); });
  }

  applyTheme();
  refreshDot();
  renderDrawer();
  renderRecent();
  probeHealth();

  /* ?demo=1 直接进演示模式，?q= 指定商品 —— 两种模式都认。
     这是分享深链的另一半：比价卡上的「分享链接」生成的就是这样的 URL，
     对方打开即自动比价。演示链接会标明「演示数据 · 非实时」，真实链接就是真比价。 */
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get('demo') === '1') {
      DEMO_MODE = true;
      renderDrawer();
    }
    const q0 = (sp.get('q') || '').trim();
    if (DEMO_MODE) ask(q0 || 'AirPods Pro 3');
    else if (q0) ask(q0);
    // PWA 快捷方式（长按桌面图标）会带这个参数进来，直接打开清单
    if (sp.get('open') === 'basket') openBasket();
  } catch { /* 没有 location / URLSearchParams 的环境直接跳过 */ }

  // 暴露给控制台，方便调试：
  //   SXM.setAdapters(['jd','pdd'])  模拟密钥已配好
  //   SXM.setDemo(true)              打开效果预览
  //   SXM.renderBasket({...})        直接渲染一张清单卡
  window.SXM = {
    parseIntent, parseDate, findCities, extractProduct, isMeaningfulProduct,
    renderShop, renderShopLive, renderFood, renderRoute,
    renderFlightTable, humanMin2,
    // 抽屉三态与无障碍：暴露出来是为了能被断言打到，而不是靠读代码相信
    adapterStatus, sourceImplemented, fmtHumanY,
    adapterEntry: (id) => ADAPTER_REGISTRY.find((x) => x.id === id) || null,
    adapterCatalog: () => ADAPTER_REGISTRY,
    openDrawer, closeDrawer, openBasket, closeBasket,
    greatCircle, estimateModes, humanHours, modeVerdict, CITY_GEO,
    probeHealth, liveCompare,
    spark, demoLive, renderBasket, renderBasketOffline, renderError,
    renderNeedProduct, renderNeedRoute, renderNeedDate,
    splitBasketInput, basketQueryList, syncBasketCount, submitBasket,
    setTheme, cycleTheme, applyTheme,
    dedupeRecent, upsertWatch, priceDrop, shopLiveToText, basketToText,
    registerCopyText, trimCopyStore, copyStored: (id) => COPY_STORE.get(id),
    parseShareText, stripUrlText, renderShareParsed,
    encodeWatchCode, decodeWatchCode, watchImport, shareUrl,
    recentList, renderRecent, watchList, watchRemove, copyText,
    get watchCount() { return watchList().length; },
    get theme() { return THEME; },
    get isDark() { return isDarkNow(); },
    get serverOk() { return SERVER_OK; },
    get lastError() { return lastLiveError; },
    setDemo(v) { DEMO_MODE = !!v; renderDrawer(); },
    setAdapters(list) {
      list.forEach((x) => { const a = ADAPTER_REGISTRY.find((y) => y.id === x); if (a) a.live = true; });
      refreshDot(); renderDrawer();
    }
  };
})();
