/* 第二笔 PR 的断言：过度承诺必须消失，替换后的真话必须存在。
   跑法：node .tmp-verify/claims-test.js
   任一旧文案残留 → RED；任一新文案缺失 → RED。 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const files = {
  'index.html': read('index.html'),
  'app.js': read('app.js'),
  'manifest.json': read('manifest.json'),
  'README.md': read('README.md'),
};
const all = Object.values(files).join('\n');

const gone = [
  '横向拉平各平台到手价；一份清单算清该分几家买',
  '横向拉平各平台到手价。把比价链接发给朋友，打开就自动比。',
  '贴一句商品名，横向拉平各平台到手价',
  '要买好几样？先算清楚该分几家买、能省多少',
  '我会逐件比价，然后回答一个问题',
  '清单只算<strong>各平台最低到手价</strong>之和',
  '本地算不了总账，先去平台看实时价',
  '下次比价发现降价会提醒你',
  '下次比价时发现降价，会在结果卡顶部提醒你。',
  '说一句人话，我把该比的都给你比了',
  '我把该比的都比了',
  '直达官方购票页',
  '同店能省一顿的钱',
  '横向拉平各平台到手价，算清一份清单该分几家买',
  '一次比多件商品，算清该分几家买',
  '逐件询价后回答一个更真实的问题',
  '\n每次真实比价都会把到手价记录下来',
  '| **机票** | **按价格自动排好序的航班表**',
];

const need = [
  ['index.html', '把各平台搜索与比价入口一次摆好'],
  ['index.html', '按你填的到手价算清该分几家买'],
  ['index.html', '打开就自动重查'],
  ['index.html', '你填上到手价'],
  ['index.html', '直达购票/比价页'],
  ['index.html', '能省一点是一点'],
  ['index.html', '接上服务端时用各平台最低到手价'],
  ['index.html', '我把该比的入口都给你摆好了'],
  ['app.js', '也可以手填到手价算总账'],
  ['app.js', '下次比价拿到真实价格时'],
  ['app.js', '拿不到真实价格就不会提醒'],
  ['manifest.json', '按你填的到手价算清一份清单该分几家买'],
  ['README.md', '我把该比的入口都摆好'],
  ['README.md', '你填上到手价，它就能回答'],
  ['README.md', '接上服务端后，每次真实比价都会把到手价记录下来'],
  ['README.md', '配好服务端与航班数据源后，给'],
];

let bad = 0;
gone.forEach((s, i) => {
  const leaked = Object.keys(files).filter((f) => files[f].includes(s));
  if (leaked.length) {
    bad++;
    console.log(`FAIL 旧承诺仍残留 [${i + 1}] ${s}\n     在：${leaked.join(', ')}`);
  } else {
    console.log(`PASS 旧承诺已清除 [${i + 1}] ${s}`);
  }
});
need.forEach(([f, s], i) => {
  if (files[f].includes(s)) {
    console.log(`PASS 新文案存在 [${i + 1}] ${f}: ${s}`);
  } else {
    bad++;
    console.log(`FAIL 新文案缺失 [${i + 1}] ${f}: ${s}`);
  }
});

// meta description 太长会被搜索引擎截断，顺便卡一下长度
const desc = files['index.html'].match(/<meta name="description" content="([^"]*)">/)[1];
if (desc.length <= 160) console.log(`PASS meta description 长度 ${desc.length} ≤ 160`);
else { bad++; console.log(`FAIL meta description 长度 ${desc.length} > 160`); }

if (bad) { console.log(`\n${bad} 项失败`); process.exit(1); }
console.log('\n全部通过');
