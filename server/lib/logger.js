/* ==========================================================================
   省心买 · 服务端 · 结构化日志与请求 ID
   --------------------------------------------------------------------------
   为什么一行一条 JSON，而不是拼接字符串：
     线上排查的顺序通常是「先按 request-id 捞出这一次请求的全部日志，
     再看是哪个平台慢、哪个平台报错」。拼接字符串做不到这件事——
     你没法把一次请求的 3 个平台调用串起来。
     单行 JSON 还能被部署平台的日志采集直接解析，不需要再写正则。

   级别由 LOG_LEVEL 控制（debug / info / warn / error），默认 info。
   error 走 stderr，其余走 stdout。
   ========================================================================== */

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

let seq = 0;

/**
 * 生成请求 ID，形如 r-<36进制时间><序号><随机>。
 * 同一毫秒内的并发请求也不会撞；而且按字符串排序约等于按时间排序，
 * 翻日志时可以直接 sort 一下看时间线。
 */
function newRid(prefix = 'r') {
  seq = (seq + 1) % 1000000;
  return prefix + '-'
    + Date.now().toString(36)
    + String(seq).padStart(3, '0')
    + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
}

function emit(level, msg, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  let line;
  try {
    line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields || {}) });
  } catch {
    // fields 里有循环引用也不能把日志本身搞崩——否则日志系统会成为故障源
    line = JSON.stringify({ t: new Date().toISOString(), level, msg, note: 'fields 无法序列化' });
  }
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

module.exports = {
  LEVELS,
  THRESHOLD,
  newRid,
  debug: (m, f) => emit('debug', m, f),
  info:  (m, f) => emit('info',  m, f),
  warn:  (m, f) => emit('warn',  m, f),
  error: (m, f) => emit('error', m, f)
};
