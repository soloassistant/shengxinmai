#!/usr/bin/env node
/* ==========================================================================
   省心买 · 密钥自检（tools/check-keys.js）
   --------------------------------------------------------------------------
   为什么要这个：四个适配器都标注过「⚠️ 未用真实密钥端到端验证过」。
   于是第一次填上真 key 的那一刻，是整条链路风险最高的时刻 —— 而那时最容易
   被「看起来成功了但一条商品都没有」带偏（分不清是 key 错、参数名错、
   权限不够，还是关键词真的没商品）。

   这个脚本做一件事：**真打一次每个已配置的数据源，把回话原样摆出来。**

   用法：
     node tools/check-keys.js                      # 全查
     node tools/check-keys.js --only=ignav         # 只查一个
     node tools/check-keys.js --q=耳机              # 换关键词（默认「耳机」）
     node tools/check-keys.js --shape              # ★ 不需要任何密钥：验证「请求形状」

   --shape 干什么：用**假凭据**让适配器自己去打真实端点，看上游的拒绝停在哪一步。
     · 停在「凭据无效」（appkey不存在 / Invalid app_key / clientId不正确 / invalid_api_key）
       → 参数名、签名位置、编码方式**已经被上游接受了**，缺的只是真凭据；
     · 停在「公共参数错误 / 签名错误 / 缺少参数」 → 形状不对，这时拿到真 key 也白搭。
   这一步能在**还没注册任何账号之前**把四家全验一遍。用的是假凭据，不消耗任何人的额度
   （ignav 只对 HTTP 200 计费，401 不计）。

   退出码：0 = 已配置的都通了；1 = 有已配置的数据源报错（可直接进 CI）。
   未配置的数据源**不算失败** —— 没填 key 是合法状态，不是错误。

   ⚠ 只打印密钥的前 4 位与长度，绝不回显完整密钥（这是要在终端/日志里留痕的）。
   ========================================================================== */

'use strict';

const path = require('node:path');
const { loadEnvFile } = require(path.join(__dirname, '..', 'server', 'lib', 'envfile'));

// 与 server.js 用同一套装载顺序：真实环境变量优先，其次 server/env.local.json
loadEnvFile(path.join(__dirname, '..', 'server', 'env.local.json'), process.env);

const dataoke = require('../server/adapters/dataoke');
const jd      = require('../server/adapters/jd');
const pdd     = require('../server/adapters/pdd');
const ignav   = require('../server/adapters/ignav');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ONLY = opt('only', '');
const Q    = opt('q', '耳机');

const mask = (v) => {
  const s = String(v || '');
  if (!s) return '(空)';
  return s.slice(0, 4) + '…(' + s.length + ' 位)';
};

const say = (s) => process.stdout.write(s + '\n');

/* 表头只在正常模式打；--shape 有自己的表头（两个都打会出现两行标题） */
if (!argv.includes('--shape')) {
  say('省心买 · 密钥自检    关键词「' + Q + '」');
  say('='.repeat(64));
}

/* 每一项：名称 / 需要的 env 键 / 怎么查一次 / 成功时怎么描述结果 */
const SOURCES = [
  {
    id: 'dataoke',
    name: '淘宝 / 天猫（大淘客）',
    keys: ['DATAOKE_APP_KEY', 'DATAOKE_APP_SECRET'],
    run: () => dataoke.search(Q, process.env),
    runShape: () => dataoke.search(Q, SHAPE_FAKE),
    pick: (r) => (r.items[0] ? r.items[0].title + ' ¥' + r.items[0].final : '')
  },
  {
    id: 'jd',
    name: '京东（京东联盟）',
    keys: ['JD_UNION_APP_KEY', 'JD_UNION_APP_SECRET'],
    run: () => jd.search(Q, process.env),
    runShape: () => jd.search(Q, SHAPE_FAKE),
    pick: (r) => (r.items[0] ? r.items[0].title + ' ¥' + r.items[0].final : '')
  },
  {
    id: 'pdd',
    name: '拼多多（多多进宝）',
    keys: ['PDD_CLIENT_ID', 'PDD_CLIENT_SECRET'],
    run: () => pdd.search(Q, process.env),
    runShape: () => pdd.search(Q, SHAPE_FAKE),
    pick: (r) => (r.items[0] ? r.items[0].title + ' ¥' + r.items[0].final : '')
  },
  {
    id: 'ignav',
    name: '机票（ignav）',
    keys: ['IGNAV_API_KEY'],
    // 机票按航线查，不按关键词；这里固定查一条国内线，专门验证密钥与端点
    run: () => {
      const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      return ignav.searchRoute({ from: 'BJS', to: 'CAN', date: d }, process.env);
    },
    runShape: () => {
      const d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      return ignav.searchRoute({ from: 'BJS', to: 'CAN', date: d }, SHAPE_FAKE);
    },
    pick: (r) => (r.items[0] ? r.items[0].carrier + ' ¥' + r.items[0].price : '')
  }
];

/* ==========================================================================
   --shape 模式：不需要任何密钥，验证「我们发的请求形状」对不对
   --------------------------------------------------------------------------
   为什么这个模式值得单独存在：**拿到 key 之前没人愿意去注册四个账号**，
   于是"形状对不对"这件事被一路推到真正接线的那天 —— 而那天一旦发现签名/参数不对，
   排查成本最高（分不清是 key 错还是我们的请求错）。
   用假凭据先打一遍，就能把"形状"这一层先排掉。
   ========================================================================== */
const SHAPE_FAKE = {
  DATAOKE_APP_KEY: 'SXM_SHAPE_PROBE', DATAOKE_APP_SECRET: 'SXM_SHAPE_PROBE',
  JD_UNION_APP_KEY: 'SXM_SHAPE_PROBE', JD_UNION_APP_SECRET: 'SXM_SHAPE_PROBE',
  PDD_CLIENT_ID: 'SXM_SHAPE_PROBE', PDD_CLIENT_SECRET: 'SXM_SHAPE_PROBE',
  IGNAV_API_KEY: 'SXM_SHAPE_PROBE'
};

/* 上游的拒绝停在哪一步 —— 这是全部判据所在：
   停在「凭据」= 参数名/签名位置/编码都被接受了；停在「参数/签名」= 我们发错了东西。 */
const CRED_RE   = /appkey|app_key|client_?id|client ?id|client下线|api_?key|未授权|授权|无效|不存在|invalid|Unauthorized/i;
const PARAM_RE  = /公共参数|参数错误|缺少|必填|必须|签名|sign|timestamp|格式|frequency|频率|非法/i;

function classify(note) {
  const s = String(note || '');
  if (PARAM_RE.test(s) && !/无效|不存在|不正确/.test(s)) return 'param';
  if (CRED_RE.test(s)) return 'cred';
  return 'unknown';
}

async function shapeMode() {
  say('省心买 · 请求形状自检（不需要任何密钥，用的是假凭据）');
  say('='.repeat(64));
  say('判据：上游的拒绝停在哪一步。停在「凭据」= 形状对；停在「参数/签名」= 形状不对。');
  let bad = 0;

  for (const s of SOURCES) {
    if (ONLY && ONLY !== s.id) continue;
    say('');
    say('▌ ' + s.name);
    const t0 = Date.now();
    let r;
    try {
      r = await s.runShape();
    } catch (e) {
      bad++;
      say('    ❌ 适配器抛异常：' + String((e && e.message) || e));
      continue;
    }
    const ms = Date.now() - t0;
    if ((r.items || []).length > 0) {
      say('    ⚠️  居然拿到了真数据（' + ms + 'ms）—— 上游没拦住假凭据，这本身要查。');
      continue;
    }
    const kind = classify(r.note);
    if (kind === 'cred') {
      say('    ✅ 形状正确：上游过了参数校验，停在凭据上（' + ms + 'ms）');
    } else if (kind === 'param') {
      bad++;
      say('    ❌ 形状有问题：上游报的是参数/签名错（' + ms + 'ms）');
    } else {
      say('    ⚠️  没能归类，请人看一眼（' + ms + 'ms）');
    }
    say('       上游原话：' + (r.note || '(空)'));
    if (r.rawSample) say('       原始字段：' + JSON.stringify(r.rawSample));
  }

  say('');
  say('='.repeat(64));
  if (bad) say(bad + ' 家的请求形状没通过 —— 拿到真 key 之前先把这里修好，否则真 key 也是白搭。');
  else say('全部通过：参数名、签名位置、编码方式都已被上游接受，缺的只是真凭据。');
  say('（本次用的是假凭据，没有消耗任何额度。）');
  process.exit(bad ? 1 : 0);
}

(async () => {
  if (argv.includes('--shape')) return shapeMode();

  let configured = 0, failed = 0;

  for (const s of SOURCES) {
    if (ONLY && ONLY !== s.id) continue;
    say('');
    say('▌ ' + s.name);
    for (const k of s.keys) say('    ' + k.padEnd(24) + ' = ' + mask(process.env[k]));

    const missing = s.keys.filter((k) => !String(process.env[k] || '').trim());
    if (missing.length) {
      say('    ⏭  未配置（缺 ' + missing.join('、') + '）—— 跳过。这是合法状态，不算失败。');
      continue;
    }
    configured++;

    const t0 = Date.now();
    let r;
    try {
      r = await s.run();
    } catch (e) {
      failed++;
      say('    ❌ 适配器抛异常：' + String((e && e.message) || e));
      continue;
    }
    const ms = Date.now() - t0;
    const n = (r.items || []).length;

    if (n > 0) {
      say('    ✅ 通了：' + n + ' 条，' + ms + 'ms');
      say('       第一条：' + s.pick(r));
      if (r.note) say('       备注：' + r.note);
    } else if (r.note) {
      /* 关键区分：note 里带"请求失败/报错/code="是**上游拒绝**（密钥或参数问题），
         而"没有推广商品"是**上游正常回答了但确实没货**。两者的处理动作完全不同。 */
      const looksLikeAuth = /请求失败|报错|code=|HTTP 4|HTTP 5|无效|不存在|invalid|签名|sign/i.test(r.note);
      if (looksLikeAuth) {
        failed++;
        say('    ❌ 上游拒绝了这次调用（' + ms + 'ms）：');
        say('       ' + r.note);
        say('       → 先按这个顺序查：① 密钥/secret 是否复制完整（有无多余空格）');
        say('         ② 联盟后台里这个应用是否已开通「商品查询」权限、是否已绑推广位(PID)');
        say('         ③ 请求参数名是否与当前文档一致（适配器文件头写了要核对哪个）');
      } else {
        say('    ⚠️  上游正常回答了，但没返回数据（' + ms + 'ms）：');
        say('       ' + r.note);
        say('       → 这**不是**密钥问题，试试换关键词 / 换一条有推广商品的航线。');
      }
      if (r.rawSample) say('       原始字段：' + JSON.stringify(r.rawSample));
    } else {
      say('    ⚠️  返回了 0 条，且适配器没有给出原因（' + ms + 'ms）—— 这本身是个缺陷，请报出来。');
      failed++;
    }
  }

  say('');
  say('='.repeat(64));
  say('已配置 ' + configured + ' 个数据源，其中失败 ' + failed + ' 个。');
  if (!configured) {
    say('');
    say('一个都没配 —— 这不是故障。没密钥时省心买会退回「手动比价」：');
    say('把各平台实时搜索页一次性摆好，不显示任何价格（不编数据）。');
    say('最快的接入顺序见 拿密钥作战单.md。');
  }
  process.exit(failed ? 1 : 0);
})();
