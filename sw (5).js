/* 포도톡 Service Worker (PT2 대응판) */
const CACHE = "podotalk-v4";
const CORE = ["/", "/index.html", "/manifest.json", "/podotalk-192.png", "/podotalk-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 아이콘 하나가 없어도 설치가 실패하지 않도록 개별 처리
    await Promise.all(CORE.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST 등은 그대로 통과
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // Worker API·CDN은 캐싱하지 않음

  // HTML과 레이어 스크립트는 네트워크 우선(새 버전 즉시 반영), 실패 시 캐시
  const isLayer = url.pathname === "/pt2.js";
  if (req.mode === "navigate" || isLayer) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(isLayer ? "/pt2.js" : "/index.html", copy));
        return res;
      }).catch(() => caches.match(isLayer ? "/pt2.js" : "/index.html"))
    );
    return;
  }

  // 나머지 정적 파일은 캐시 우선
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => hit))
  );
});

/* 웹푸시 — 발송자는 podotalk-api 하나뿐 */
self.addEventListener("push", (e) => {
  let d = { title: "포도톡", body: "새 메시지가 있습니다", room_id: "" };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: "/podotalk-192.png",
    badge: "/podotalk-192.png",
    tag: d.tag || "podotalk",
    renotify: true,
    data: { room_id: d.room_id || "" },
    vibrate: [180, 80, 180],
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const room = e.notification.data?.room_id || "";
  // PT2 는 서버 방 id 앞에 sv_ 를 붙여 라우팅한다
  const target = room ? `/#/talk/room/sv_${room}` : "/#/talk/open";
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: "OPEN_ROOM", room_id: room });
        return;
      }
    }
    await clients.openWindow(target);
  })());
});
