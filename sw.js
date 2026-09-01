/* Podoya Service Worker — "서버 = 알람시계" 설계의 폰 쪽 절반
   서버가 보낸 "일어나" 푸시를 받아 알림만 띄운다.
   여기서 Stripe·Gmail을 직접 부르지 않는다:
     · Service Worker에는 localStorage가 없다 → 키를 읽을 수 없다
     · 키를 IndexedDB로 복사하면 공격 표면만 늘어난다
     · 크롬은 푸시를 받으면 어차피 알림을 반드시 띄워야 한다
   실행은 사용자가 알림을 탭한 뒤 앱 안에서 한다.
   → 서버도 SW도 키를 본 적이 없다.

   ※ 2026-08-21 — 셸 캐싱을 추가했다.
     화면(index.html)과 아이콘만 캐시에 둔다. 재방문 때 즉시 뜨고,
     뒤에서 새 버전을 받아 다음 실행에 반영한다.
     캐시에 넣는 것은 같은 도메인 GET 뿐이다. 외부 API(워커·AI·카카오)는
     손대지 않으므로 응답이 낡을 일이 없다.
     배포할 때마다 아래 SHELL_CACHE 의 v 숫자를 올린다.

   ※ 2026-08-23 — .js 는 네트워크 우선(1.5초)으로 바꿨다.
     앱 파일을 고칠 때마다 버전을 올리지 않아도 반영된다. */

var APP = './index.html';
var SW_VER = '2026-09-01b';  // 이 값을 바꾸면 브라우저가 새 파일로 인식한다

/* ── 셸 캐싱 설정 ───────────────────────────────────────── */
var SHELL_CACHE = 'podoya-shell-v14';                   // 배포 때마다 v2, v3…
var ROOT = new URL('./', self.location.href).href;      // 예: https://podoya.ai.kr/
var SHELL = [ROOT, ROOT + 'manifest.json', ROOT + 'podo-192.png'];
var JS_TIMEOUT = 1500;   // .js 를 이 시간 안에 못 받으면 캐시로 넘어간다

self.addEventListener('install', function(e){
  e.waitUntil(
    (self.caches
      ? caches.open(SHELL_CACHE)
          .then(function(c){ return c.addAll(SHELL); })
          .catch(function(){})               // 파일 하나가 없어도 설치는 계속된다
      : Promise.resolve())
    .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    // 1) 예전 버전이 남긴 캐시를 비운다 — 단, 지금 쓰는 셸 캐시는 남긴다
    //    (여기서 전부 지우면 방금 저장한 화면까지 날아가 캐싱이 무의미해진다)
    (self.caches ? caches.keys().then(function(names){
      return Promise.all(names.map(function(n){
        if (n !== SHELL_CACHE) return caches.delete(n);
      }));
    }) : Promise.resolve())
    // 2) 열려 있는 탭을 곧바로 넘겨받는다
    .then(function(){ return self.clients.claim(); })
    // 3) 이미 열린 화면이 옛것이면 새로 불러오게 한다
    .then(function(){
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    })
    .then(function(list){
      for (var i = 0; i < list.length; i++) {
        try { list[i].postMessage({ type: 'sw-updated', ver: SW_VER }); } catch (err) {}
      }
    })
    .catch(function(){ return self.clients.claim(); })
  );
});

/* ── 셸 캐싱 ─────────────────────────────────────────────
   화면: 캐시된 것을 즉시 보여주고, 뒤에서 새로 받아 저장한다.
   정적 파일(아이콘·매니페스트): 캐시 먼저, 없으면 받아서 저장한다.
   그 밖(POST·외부 도메인)은 아예 가로채지 않는다. */
self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;     // 외부 API는 그대로 통과

  var isDoc = (req.mode === 'navigate') ||
              ((req.headers.get('accept') || '').indexOf('text/html') > -1);

  if (isDoc) {
    e.respondWith(
      caches.open(SHELL_CACHE).then(function(c){
        return c.match(ROOT).then(function(hit){
          var net = fetch(req).then(function(res){
            if (res && res.ok) { try { c.put(ROOT, res.clone()); } catch (err) {} }
            return res;
          }).catch(function(){ return hit; });
          return hit || net;                            // 있으면 즉시, 없으면 네트워크
        });
      }).catch(function(){ return fetch(req); })
    );
    return;
  }

  /* ── .js 파일: 네트워크 먼저, 1.5초 안 오면 캐시 ──────────
     앱 파일을 고칠 때마다 SHELL_CACHE 버전을 올리지 않아도
     최신이 반영되게 한다. 느리거나 오프라인이면 캐시로 즉시 전환.
     (index.html 은 용량이 커서 지금처럼 캐시 우선으로 둔다) */
  if (/\.js$/i.test(url.pathname)) {
    e.respondWith(
      caches.open(SHELL_CACHE).then(function(c){
        return c.match(req).then(function(hit){
          var net = fetch(req).then(function(res){
            if (res && res.ok && res.type === 'basic') {
              try { c.put(req, res.clone()); } catch (err) {}
            }
            return res;
          });
          if (!hit) return net;                     // 캐시에 없으면 기다린다
          var late = new Promise(function(done){
            setTimeout(function(){ done(hit); }, JS_TIMEOUT);
          });
          return Promise.race([ net.catch(function(){ return hit; }), late ]);
        });
      }).catch(function(){ return fetch(req); })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function(c){
            try { c.put(req, copy); } catch (err) {}
          });
        }
        return res;
      });
    }).catch(function(){ return fetch(req); })
  );
});

self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { try { d = { body: e.data.text() }; } catch (e2) { d = {}; } }

  var url = d.url || (d.id ? (APP + '?report=' + encodeURIComponent(d.id)) : APP);
  var opts = {
    body: d.body || '탭하면 정리해드려요',
    tag: d.tag || 'podoya',
    renotify: true,
    requireInteraction: !!d.sticky,
    data: { url: url },
    vibrate: [80, 40, 80]
  };
  e.waitUntil(self.registration.showNotification(d.title || '🍇 포도야', opts));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || APP;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf('index.html') >= 0 || c.url.indexOf('/Podoaiapp/') >= 0) {
          if ('navigate' in c) { try { c.navigate(url); } catch (err) {} }
          if ('focus' in c) return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('pushsubscriptionchange', function(e){
  e.waitUntil(self.registration.showNotification('🍇 포도야', {
    body: '알림 연결이 갱신됐어요. 앱을 한 번 열어주세요.',
    tag: 'podoya-resub',
    data: { url: APP }
  }));
});
