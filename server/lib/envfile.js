'use strict';
const fs = require('fs');

/**
 * 读一个 {"KEY":"value"} 形式的 JSON 文件，合并进 target（通常是 process.env）。
 *
 * 为什么要有这个文件：部署沙箱里设置不了进程环境变量，联盟密钥只能随目录上传；
 * 集中到一个文件，密钥不散落进代码。真实环境变量永远优先——
 * 同名键在环境里已存在时不覆盖，这样本地调试用 env、线上用文件，两边不打架。
 *
 * 文件不存在 / 坏 JSON / 非对象 → 什么都不做，返回 0。密钥缺失会让
 * 对应平台自动处于「未接入」状态（/api/health 可见），不该在启动时炸掉。
 */
function loadEnvFile(file, target) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
    let n = 0;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v !== 'string' || !v) continue;
      if (Object.prototype.hasOwnProperty.call(target, k)) continue;
      target[k] = v;
      n++;
    }
    return n;
  } catch { return 0; }
}

module.exports = { loadEnvFile };
