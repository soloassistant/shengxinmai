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

say('省心买 · 密钥自检    关键词「' + Q + '」');
say('='.repeat(64));

/* 每一项：名称 / 需要的 env 键 / 怎么查一次 / 成功时怎么描述结果 */
const SOURCES = [
  {
    id: 'dataoke',
    name: '淘宝 / 天猫（大淘客）',
    keys: ['DATAOKE_APP_KEY', 'DATAOKE_APP_SECRET'],
    run: () => dataoke.search(Q, process.env),
    pick: (r) => (r.items[0] ? r.items[0].title + ' ¥' + r.items[0].final : '')
  },
  {
    id: 'jd',
    name: '京东（京东联盟）',
    keys: ['JD_UNION_APP_KEY', 'JD_UNION_APP_SECRET'],
    run: () => jd.search(Q, process.env),
    pick: (r) => (r.items[0] ? r.items[0].title + ' ¥' + r.items[0].final : '')
  },
  {
    id: 'pdd',
    name: '拼多多（多多进宝）',
    keys: ['PDD_CLIENT_ID', 'PDD_CLIENT_SECRET'],
    run: () => pdd.search(Q, process.env),
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
    pick: (r) => (r.items[0] ? r.items[0].carrier + ' ¥' + r.items[0].price : '')
  }
];

(async () => {
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
