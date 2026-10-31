/* ==========================================================================
   省心买 · 服务端 · 客户端地址
   --------------------------------------------------------------------------
   只回答一个问题：这个请求该用哪个 IP 做限流的 key。

   X-Forwarded-For 的语义是「一路代理各自把前一跳**追加**到右边」：
     客户端伪造头 X-Forwarded-For: 9.9.9.9 → 代理追加真实 IP
       → 到达我们时是 "9.9.9.9, <真实IP>"
   所以**最左边**（split(',')[0]）是客户端可以随便写的值 ——
   拿它当限流 key，攻击者每次请求换一个假 IP 就绕开了令牌桶，
   还能把假 IP 写进日志（日志投毒）。

   取**最右边**（最后一跳）：那是我们自己的反向代理亲眼看来的地址 ——
   代理没开 XFF 时它不存在，回退 socket.remoteAddress（也是代理的地址，
   两个取法在同一部署下行为一致）；代理追加时它是唯一不可伪造的那一段。
   前提是前面只有一层可信代理 —— 本项目的部署形态正是如此，
   多层不可信代理链不属于这个文件的职责。
   ========================================================================== */
'use strict';

function pickClientIp(headers, remoteAddress) {
  const xff = headers ? headers['x-forwarded-for'] : null;
  if (typeof xff === 'string') {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return remoteAddress || 'unknown';
}

module.exports = { pickClientIp };
