/* 嘘つき村の事件簿 Service Worker
 *
 * 何をするか
 * - ページ（index.html・support.html の読み込み）: ネット優先。取れたらキャッシュを新しくする。
 *   オフラインのとき、または4秒たっても返事が無いときはキャッシュを出す。
 *   キャッシュに無いページのとき、代わりにアプリ（index.html）を出すのはアプリのページ（./ と ./index.html）だけ。
 *   ほかのページ（support.html や存在しない URL）にアプリの画面を出すことはしない。
 *   → index.html・support.html を直して公開すれば、次に開いたときにすぐ届く（このファイルの版を上げなくてよい）
 * - manifest.json・アイコンなど、同じ場所のほかのファイル: キャッシュ優先（無ければネットから取って入れる）
 *   → manifest.json やアイコン・先にキャッシュするファイルの一覧を変えたときは、下の VERSION を上げる（v2 → v3）
 * - Google Fonts: 書体の CSS（fonts.googleapis.com）は stale-while-revalidate
 *   （キャッシュをすぐ出し、裏で新しいものに入れ替える）。書体のファイル（fonts.gstatic.com）は
 *   URL ごとに中身が変わらないので、キャッシュにあればそれを使う（毎回書き直さない）。
 *   一度表示した文字は、オフラインでもこの書体で出る。
 * - 古い版のキャッシュは activate で消す。消すのは名前が「usotsuki-」で始まるものだけ
 *   （github.io は同じドメインにほかのアプリも載るので、ほかのアプリのキャッシュには触らない）
 * - ほかのアプリに消されても入れ直す: キャッシュの置き場所はドメインに1つで、同じ github.io のほかのアプリの中には
 *   自分以外のキャッシュを全部消すものがある。そこでページを開くたびに（ネットにつながっているとき）、
 *   先にキャッシュするファイル（PRECACHE）のうち無くなったものだけを取り直す（refill）。
 *   消された直後に通信なしで開いた場合は防げないが、一度つながった状態で開けば元に戻る。
 *
 * 登録は index.html の最後の小さなスクリプトが行う（iOS アプリの中・Claude Artifact などでは登録しない）。
 */
'use strict';

const VERSION = 'v2'; // v2: support.html を先にキャッシュに入れた（2026-10-08）
const PREFIX = 'usotsuki-';
const APP_CACHE = PREFIX + 'app-' + VERSION;
const FONT_CACHE = PREFIX + 'fonts-v1'; // 書体は版上げで消さない。書体そのものを変えたときだけ fonts-v2 に
const FONT_MAX = 400;                   // 書体のキャッシュは最大この件数（超えたら古いものから消す）
const PAGE_TIMEOUT = 4000;              // ページの返事をこれ以上待たない（ms）。キャッシュが無ければ待ち続ける

// 先にキャッシュするもの（sw.js からの相対パス）
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './support.html',
];

const FONT_CSS_HOST = 'fonts.googleapis.com';
const FONT_FILE_HOST = 'fonts.gstatic.com';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // HTTP のキャッシュを通さずに取る（版を上げたとき、古いファイルを入れないため）
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [APP_CACHE, FONT_CACHE];
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith(PREFIX) && !keep.includes(n))
      .map((n) => caches.delete(n)));
    // 画面の読み込みを Service Worker の起動と並行して始める（対応しているブラウザだけ）
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* 使えなければそのまま */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === FONT_CSS_HOST) { event.respondWith(fontCss(event)); return; }
  if (url.hostname === FONT_FILE_HOST) { event.respondWith(fontFile(event)); return; }

  // ほかのサイトのもの・このアプリの外（同じドメインの別のアプリ）は触らない
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  if (req.mode === 'navigate') { event.respondWith(page(event)); return; }
  event.respondWith(asset(req));
});

/* ---------- ページ: ネット優先、オフライン・遅いときはキャッシュ ---------- */
async function page(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const key = pageKey(req.url);
  let saving = null;

  const network = (async () => {
    const res = (await event.preloadResponse) || (await fetch(req));
    if (res && res.ok && res.type === 'basic') saving = cache.put(key, res.clone()).catch(() => {});
    return res;
  })();
  // 遅くてキャッシュを先に出したときも、届いたらキャッシュを新しくしておく。
  // つながっているときは、ほかのアプリに消された分（PRECACHE の欠け）も入れ直す
  event.waitUntil(network.then(() => saving).then(refill).catch(() => {}));

  const fromCache = async () => {
    let hit = await cache.match(key);
    // 代わりにアプリを出すのは、アプリのページ（./ と ./index.html）のときだけ
    if (!hit && isAppPage(key)) hit = (await cache.match('./index.html')) || (await cache.match('./'));
    return hit ? clean(hit) : null;
  };

  try {
    const res = await Promise.race([network, wait(PAGE_TIMEOUT)]);
    if (res) {
      if (res.status >= 500) return (await fromCache()) || res; // サーバーの不調ならキャッシュを優先
      return res;
    }
    return (await fromCache()) || (await network); // 4秒たった
  } catch (err) {
    const hit = await fromCache(); // オフライン
    if (hit) return hit;
    throw err;
  }
}

// アプリのページか（スコープの直下 ./ と ./index.html）
function isAppPage(href) {
  const p = new URL(href).pathname, base = new URL(self.registration.scope).pathname;
  return p === base || p === base + 'index.html';
}

// ?以降と#以降を落とした URL を、ページのキャッシュの名前にする
function pageKey(href) {
  const u = new URL(href);
  u.search = '';
  u.hash = '';
  return u.href;
}

// 転送（リダイレクト）を経たレスポンスは、画面の読み込みにそのまま返すと Safari が拒むので作り直す
function clean(res) {
  if (!res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

// 先にキャッシュするファイルのうち、キャッシュに無いものだけを取り直す（同じドメインのほかのアプリに消されたとき）
async function refill() {
  const cache = await caches.open(APP_CACHE);
  await Promise.all(PRECACHE.map(async (u) => {
    if (await cache.match(u)) return;
    try {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (res.ok && res.type === 'basic') await cache.put(u, res);
    } catch (e) { /* 取れなければ次に開いたときにまた試す */ }
  }));
}

/* ---------- 同じ場所のほかのファイル: キャッシュ優先 ---------- */
async function asset(req) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
  return res;
}

/* ---------- Google Fonts ---------- */
// 書体の CSS: stale-while-revalidate
async function fontCss(event) {
  const req = event.request;
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => {
    // <link> で読む CSS は中身の見えない形（opaque）で届く。それも入れておく
    if (res.ok || res.type === 'opaque') {
      event.waitUntil(cache.put(req, res.clone()).then(() => (hit ? null : trim(cache))).catch(() => {}));
    }
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

// 書体のファイル: キャッシュにあればそれ、無ければ取って入れる
async function fontFile(event) {
  const req = event.request;
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {}));
  }
  return res;
}

// 書体のキャッシュが FONT_MAX 件を超えたら、古く入れたものから消す
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - FONT_MAX; i++) await cache.delete(keys[i]);
}
