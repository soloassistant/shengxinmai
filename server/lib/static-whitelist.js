/* ==========================================================================
   对外静态文件白名单 —— 静态服务只放行这里列出的文件
   --------------------------------------------------------------------------
   为什么是白名单而不是黑名单（2026-10-08 事故换来的）：

   原来是「以 . 开头的路径段一律不对外」。这条挡得住 .git/、.data/、.env，
   却挡不住 server/ —— 而最要命的东西正好全在那里：env.local.json（密钥）、
   adapters/（各联盟字段映射）、lib/envfile.js（密钥怎么被加载的）。
   线上实测这些全都是 200。

   而且它**移不走**：部署沙箱设不了环境变量，密钥只能随目录上传，
   于是必然落在静态根之内（server.js 里 ROOT = __dirname/..）。

   黑名单的根本毛病是**它必须穷举**，漏一个就泄一个（fail-open）。
   白名单反过来：没列进来的一律 404，将来新增的敏感文件
   （新的密钥、调试脚本、日志）**默认就不会被发出去**（fail-closed）。

   ⚠ 与 `.github/workflows/pages.yml` 里那份 cp 白名单是**同一个判断**，
     必须集合相等（pages.yml 额外有个 .nojekyll，是 Pages 专用，不在本表）。
     两边漂移就是 bug：Pages 漏一个 → 线上静默 404，页面对此毫无感知；
     这里多一个 / 少一个 → 要么漏文件，要么坏页面。
     test-quality.js 里有断言守住这件事，别手工同步。
   ========================================================================== */
'use strict';

const STATIC_WHITELIST = new Set([
  // 页面本体与脚本
  'index.html',
  'app.js',
  'data.js',
  'styles.css',
  'sw.js',
  // 安装为桌面应用所需
  'manifest.json',
  'icon.svg',
  'favicon-32.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  // 分享卡片预览图
  'og-image.png'
]);

module.exports = { STATIC_WHITELIST };
