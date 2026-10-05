/* ==========================================================================
   省心买 · Service Worker
   --------------------------------------------------------------------------
   目标只有一个：让网页能装到手机桌面、点开就像 App，并且断网时不至于白屏。
   小程序这条路对个人主体是堵死的（不支持 web-view、不能开微信支付），
   所以 PWA 是当前唯一能给用户的"像 App"的形态。

   两条策略，界限很清楚：

     · 同源静态资源（html / css / js / icon）
       → **网络优先**，拿到新版本就用新版本；断网才回落到缓存。
         为什么不用 stale-while-revalidate：那会让用户拿着上一版 app.js
         配这一版接口，出现"页面能开但功能对不上"这种最难查的问题。
         为了快那一帧去冒这个险，不值得。

     · /api/*
       → **永不缓存，直接放行**。
         价格是有时效的。缓存下来的价格会变成"用户离线时看到的报价"，
         而他可能照着这个价做决定。宁可离线时明说拿不到，
         也不要给一个看起来能用的旧价格。
   ========================================================================== */

/* 缓存名要跟着**预缓存清单**走：SHELL 里加了文件就得升版本号，
   否则已经装过 App 的用户不会重新跑 install，新图标永远进不了缓存
   （在线时看不出来 —— 网络优先照样能取到；一断网才暴露）。 */
const VERSION = 'sxm-shell-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './app.js',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // 单个文件取不到不该让整个安装失败，所以逐个 add 而不是 addAll
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 非 GET 一律不碰
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 跨域（各平台跳转链接、图片 CDN）不拦，免得把别人的资源缓存到自己名下
  if (url.origin !== self.location.origin) return;

  // 接口永不缓存
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => { /* 存不下也不影响本次 */ });
      }
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      // 断网且没缓存：单页应用统一回落到应用壳，至少界面能打开
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线，且这个资源没有缓存。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
