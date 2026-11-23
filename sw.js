/* The Crucible, service worker. The page comes from the network when there is one, so updates arrive on the
   next visit; its scripts are content-addressed and served from the cache. API calls go to api.anthropic.com
   and never pass through here. */
const CACHE = 'crucible-c9b42a5bc785', SHELL = ["index.html", "app.d949950852.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "vendor/react-18.3.1/react.production.min.js", "vendor/react-dom-18.3.1/react-dom.production.min.js", "vendor/anthropic-sdk-1.7.0/sdk.mjs", "vendor/anthropic-sdk-1.7.0/node.browser.mjs", "vendor/anthropic-sdk-1.7.0/agent-toolset-node.browser.mjs", "vendor/anthropic-sdk-1.7.0/opentelemetry-api.mjs", "vendor/anthropic-sdk-1.7.0/standardwebhooks.mjs", "vendor/anthropic-sdk-1.7.0/stablelib-base64.mjs", "vendor/anthropic-sdk-1.7.0/fast-sha256.mjs"];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k.startsWith('crucible-') && k !== CACHE).map(k => caches.delete(k))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); }
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r)));
});
