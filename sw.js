/* 포도톡 Service Worker (PT2 대응판)
   ──────────────────────────────────────────────────────────────
   v6 에서 바뀐 것
   ① /manifest.json 을 캐시에서 뺐다.
      크롬은 앱을 설치·갱신할 때 이 파일을 다시 읽는데, 캐시 우선으로
      돌려주면 옛 숏컷 목록이 계속 살아나 홈화면 메뉴가 안 바뀐다.
   ② pt2-cfg 캐시는 지우지 않는다.
      방별 알림 끄기 목록이 여기 들어 있어서, 지금까지는 서비스워커가
      갱신될 때마다 꺼둔 방이 도로 켜졌다.
   ③ 오프라인일 때 빈 응답이 나가던 곳을 막았다.
   ────────────────────────────────────────────────────────────── */
const CACHE = "podotalk-v43";
const KEEP = [CACHE, "pt2-cfg"];               /* 알림 설정 캐시는 건드리지 않는다 */

/* manifest.json 은 일부러 뺐다. 넣으면 숏컷이 옛 것으로 굳는다. */
const CORE = ["/", "/index.html", "/podotalk-192.png", "/podotalk-512.png"];

/* 항상 서버를 먼저 보는 것들 — 새 버전이 바로 반영되어야 하는 파일 */
const FRESH = ["/pt2.js", "/manifest.json", "/sw.js"];

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
    await Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
    // 옛 버전이 캐시에 넣어둔 manifest 가 남아 있으면 확실히 뽑아낸다
    try { const c = await caches.open(CACHE); await c.delete("/manifest.json"); } catch (err) {}
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST 등은 그대로 통과
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // Worker API·CDN은 캐싱하지 않음

  // HTML·레이어 스크립트·manifest 는 네트워크 우선(새 버전 즉시 반영), 실패 시 캐시
  const fresh = FRESH.includes(url.pathname);
  if (req.mode === "navigate" || fresh) {
    const key = req.mode === "navigate" ? "/index.html" : url.pathname;
    e.respondWith(
      fetch(req).then((res) => {
        // manifest 는 오프라인 대비로만 복사해 둔다. 읽을 때는 늘 네트워크가 먼저다.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
        }
        return res;
      }).catch(async () => {
        const hit = await caches.match(key);
        return hit || new Response("", { status: 504, statusText: "offline" });
      })
    );
    return;
  }

  // 나머지 정적 파일은 캐시 우선
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      // 여기서 hit 은 반드시 undefined 다. 빈 응답 대신 제대로 된 오류를 돌려준다.
      return new Response("", { status: 504, statusText: "offline" });
    }
  })());
});

/* 웹푸시 — 발송자는 podotalk-api 하나뿐 */
self.addEventListener("push", (e) => {
  let d = { title: "포도톡", body: "새 메시지가 있습니다", room_id: "" };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil((async () => {
    // 앱에서 꺼둔 방이면 알리지 않는다 (목록은 캐시로 전달받는다)
    try {
      const c = await caches.open("pt2-cfg");
      const r = await c.match("/__pt2_mute");
      if (r) {
        const list = await r.json();
        if (d.room_id && Array.isArray(list) && list.indexOf(String(d.room_id)) >= 0) return;
      }
    } catch (err) {}
    await self.registration.showNotification(d.title, {
      body: d.body,
      icon: "/podotalk-192.png",
      badge: "/podotalk-192.png",
      tag: d.tag || "podotalk",
      renotify: true,
      data: { room_id: d.room_id || "" },
      vibrate: [180, 80, 180],
    });
  })());
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
