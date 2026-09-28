/* ==========================================================================
   省心买 · 服务端 · 签名层
   --------------------------------------------------------------------------
   为什么单独一个文件：签名是联盟接入里唯一「错了就全盘失败」的地方，
   而且算法是死的、可测的。所以它单独成层，并且必须能被自测覆盖。

   四个平台的规则都记在下面，附文档出处。改之前先看注释。
   ========================================================================== */

'use strict';

const crypto = require('node:crypto');

function md5Upper(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();
}

/**
 * 排序后「参数名 + 参数值」直接相连，中间无分隔符。
 *
 * 出处：京东联盟官方文档《签名算法》
 *   union.jd.com/helpcenter/13246-13312-108188
 * 官方给的拼接示例原文（可作为黄金测试基准）：
 *   360buy_param_json{"goodsReqDTO":{"keyword":"鞋","pageIndex":"1"}}
 *   app_keyff1c4e42d4b864f45c6630f5a3604c31
 *   formatjsonmethodjd.union.open.goods.query...
 * 注意 360buy_param_json 排在 app_key 前面——因为它以数字开头，字典序在前。
 */
function concatKV(params) {
  return Object.keys(params).sort().map((k) => k + params[k]).join('');
}

/** 排序后以 & 连接，形如 appKeyxxx&versionv1.2.0 */
function concatAmp(params) {
  return Object.keys(params).sort().map((k) => k + params[k]).join('&');
}

/* --------------------------------------------------------------------------
   京东 JOS —— MD5(appSecret + 拼接串 + appSecret)，32 位大写
   出处：官方文档 + 多份实现互相印证
   -------------------------------------------------------------------------- */
function signJd(params, appSecret) {
  return md5Upper(appSecret + concatKV(params) + appSecret);
}

/* --------------------------------------------------------------------------
   拼多多 · 多多进宝 —— 与京东同构：MD5(clientSecret + 拼接串 + clientSecret)
   出处：多多进宝开放平台公开文档

   注：这个函数和 signJd 的计算结果**必然相同**，因为两家规则本身就同构。
   之所以还分开写两个函数，是为了各自带上自己的文档出处——
   将来某一家改了规则，改哪一个一目了然。测试里固化了「两者相等」这个事实，
   谁哪天不小心只改了一边，测试会红。
   未经真实密钥端到端验证。
   -------------------------------------------------------------------------- */
function signPdd(params, clientSecret) {
  return md5Upper(clientSecret + concatKV(params) + clientSecret);
}

/* --------------------------------------------------------------------------
   大淘客 · 老版 sign —— MD5(拼接串 + "&key=" + appSecret)
   注意和大不相同：这里是 & 连接，且 secret 放在尾部而不是两头。
   出处：大淘客开放平台验签文档 dataoke.com/pmc/open-gz.html?id=41
        （原文：「原有验签方式不受影响，同时兼容」——所以老版仍然可用）
   -------------------------------------------------------------------------- */
function signDataoke(params, appSecret) {
  return md5Upper(concatAmp(params) + '&key=' + appSecret);
}

/* --------------------------------------------------------------------------
   大淘客 · 新版 signRan —— MD5("appKey=x&timer=y&nonce=z&key=secret")
   出处：同上。「key」位置放的是 appSecret，不是变量名。
   -------------------------------------------------------------------------- */
function signDataokeRan(appKey, appSecret, nonce, timer) {
  return md5Upper('appKey=' + appKey + '&timer=' + timer + '&nonce=' + nonce + '&key=' + appSecret);
}

/** 大淘客新版要求的 6 位随机数 */
function makeNonce() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = {
  md5Upper, concatKV, concatAmp,
  signJd, signPdd, signDataoke, signDataokeRan, makeNonce
};
