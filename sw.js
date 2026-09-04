// sw.js
// Service Worker。アプリシェルをキャッシュしてオフライン起動を可能にする。
// - アプリ本体(HTML/CSS/JS/アイコン/Leaflet)は cache-first。
// - 地図タイルは実行時キャッシュ（閲覧済みエリアはオフラインでも表示）。
//
// 更新時は CACHE のバージョンを上げること（古いキャッシュは activate で削除）。

const CACHE = 'orbis-v3';
const TILE_CACHE = 'orbis-tiles-v1';

// 事前キャッシュするアプリシェル。
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './js/app.js',
  './js/geo.js',
  './js/util.js',
  './js/db.js',
  './js/recorder.js',
  './js/history.js',
  './js/settings.js',
  './js/config.js',
  './js/analysis.js',
  './js/spots.js',
  './js/alerts.js',
  './js/speech.js',
  './js/replay.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      // 1件の失敗で全体が失敗しないよう個別に追加
      await Promise.allSettled(SHELL.map((u) => c.add(u)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 地図タイル: cache-first + 実行時キャッシュ
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(
      (async () => {
        const c = await caches.open(TILE_CACHE);
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          c.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })()
    );
    return;
  }

  // それ以外: cache-first、無ければネット取得（同一オリジンは実行時キャッシュ）
  e.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (url.origin === location.origin) {
          const c = await caches.open(CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        // オフラインでのページ遷移は index にフォールバック
        if (req.mode === 'navigate') {
          const idx = await caches.match('./index.html');
          if (idx) return idx;
        }
        throw err;
      }
    })()
  );
});
