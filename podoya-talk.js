/* ══════════════════════════════════════════════════════════════
   🍇 PODOYA 링크 레이어 — podoya.ai.kr 에서 바깥 서비스로 잇는 다리
   ──────────────────────────────────────────────────────────────
   원칙 : index.html 안의 기존 코드는 한 줄도 고치지 않는다.
          여기서 전역 함수를 덮어쓰기(override)만 한다.

   하는 일 :
     ① 포도톡 이동 주소를 pododa.html → podotalk.kr 로 바꾼다
     ② podotalkPushMsg() 를 podotalk-api 워커 호출로 바꾼다
        (예약 브리핑 · 문서 보관 · 커넥션 결과가 진짜 포도톡으로 감)
     ③ "포도톡 방 연결" 화면을 발송 채널 설정 안에 끼워 넣는다
     ④ 포도다 이동 주소를 pododa.html → pododa.kr 로 바꾼다
        (격자 아이콘 · AI매칭 상품등록 · 상점등록 · 포도다에 등록)
     ⑤ 죽은 비서 버튼(asTalk · botBack)을 감춘다
     ⑥ 매일 리포트 폼이 마지막에 쓴 방 이름을 기억하게 한다
     ⑦ 알람시계 서버 주소를 박아넣고 입력칸을 감춘다
     ⑧ 포도야 비서 첫 줄의 🍇 를 뺀다

   안 하는 일 :
     · 포도야 비서 inbox/outbox 양방향 — 나중에
     · 포도톡(pt2.js / podotalk-worker.js) 수정 — 필요 없음
     · pododa.html 삭제 — pododa.kr 의 키 브리지가 아직 물고 있다

   붙이는 법 : index.html 의 </body> 바로 위에
               <script src="podoya-talk.js"></script>
   ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var PTL_VER = "13";

  /* ── 설정 ────────────────────────────────────────────────── */
  var API  = "https://podotalk-api.hasin7jk.workers.dev";  /* 워커 */
  var SITE = "https://podotalk.kr";                        /* 화면 */
  var PODODA = "https://pododa.kr";                        /* 포도다 */
  var PFX  = "sv_";        /* pt2.js 가 서버 방을 이 접두어로 읽는다 */

  var K_UID   = "podoya_pt_uid";     /* 포도야가 쓰는 발신자 id */
  var K_ROOMS = "podoya_pt_rooms";   /* 연결된 포도톡 방 목록 */

  var MSG_MAX = 1900;      /* 워커 한도 2000. 여유를 둔다 */
  var GAP_MS  = 400;       /* 워커 분당 25건. 연속 전송 간격 */

  /* ── 작은 도구들 ──────────────────────────────────────────── */
  function LS(k, d) { try { return localStorage.getItem(k) || (d || ""); } catch (e) { return d || ""; } }
  function LSS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  /* 포도야 index.html 에는 toast() 정의가 없다. 부르는 곳마다
     try/catch 로 감싸져 있어서 조용히 지나갈 뿐이다. 그래서
     여기서 작은 알림창을 직접 그린다. toast() 가 생기면 그걸 쓴다. */
  function say(m, ms) {
    try { if (typeof toast === "function") { toast(m); return; } } catch (e) {}
    try {
      var el = document.getElementById("ptl-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "ptl-toast";
        document.body.appendChild(el);
      }
      el.textContent = String(m == null ? "" : m);
      el.style.cssText =
        "position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:100000;" +
        "max-width:88%;box-sizing:border-box;background:rgba(23,23,28,.94);color:#fff;" +
        "padding:12px 16px;border-radius:13px;font-size:13.5px;font-weight:700;line-height:1.5;" +
        "text-align:center;font-family:inherit;box-shadow:0 6px 22px rgba(0,0,0,.28);" +
        "pointer-events:none;opacity:1;transition:opacity .3s";
      clearTimeout(window._ptlToastT);
      window._ptlToastT = setTimeout(function () {
        try { el.style.opacity = "0"; } catch (e) {}
      }, ms || 2200);
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* 발신자 id — 워커 검사 규칙 /^[a-zA-Z0-9_-]{6,64}$/ 를 지킨다.
     포도톡의 내 id 는 다른 도메인에 있어서 읽을 수 없다. 그래서
     포도야는 자기 id 를 따로 하나 만들어 쓴다. 방 참여자 목록에는
     "🍇 포도야" 라는 이름으로 한 자리 잡는다. */
  function myUid() {
    var u = LS(K_UID, "");
    if (/^[a-zA-Z0-9_-]{6,64}$/.test(u)) return u;
    var A = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
    try {
      var r = new Uint8Array(14);
      (window.crypto || {}).getRandomValues
        ? window.crypto.getRandomValues(r)
        : (function () { for (var i = 0; i < 14; i++) r[i] = Math.floor(Math.random() * 256); })();
      for (var i = 0; i < 14; i++) s += A[r[i] % A.length];
    } catch (e) {
      s = String(Date.now()) + Math.random().toString(36).slice(2, 8);
    }
    u = "podoya-" + s;
    LSS(K_UID, u);
    return u;
  }

  var NICK = "🍇 포도야";

  /* ── 연결된 방 목록 ───────────────────────────────────────── */
  /* [{ id:"서버 uuid", code:"ABC123", name:"방 이름", def:1 }] */
  function rooms() {
    try { var a = JSON.parse(LS(K_ROOMS, "[]")); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveRooms(a) { LSS(K_ROOMS, JSON.stringify(a || [])); }
  function defRoom() {
    var a = rooms();
    if (!a.length) return null;
    for (var i = 0; i < a.length; i++) if (a[i].def) return a[i];
    return a[0];
  }

  /* ── 워커 호출 ────────────────────────────────────────────── */
  function api(path, body) {
    /* GET 에 Content-Type 을 붙이면 브라우저가 예비 요청(preflight)을
       한 번 더 보낸다. 안 붙이면 그 단계를 건너뛴다. */
    var o = body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method: "GET" };
    return fetch(API + path, o).then(function (r) {
      /* 워커가 그 길을 모르면 HTML 을 뱉는다. 바로 .json() 하면
         엉뚱한 파싱 오류가 나므로 글로 먼저 받는다. */
      return r.text().then(function (t) {
        try { return JSON.parse(t); }
        catch (e) { return { ok: false, error: "서버 응답을 읽지 못했어요 (" + r.status + ")" }; }
      });
    }).catch(function () {
      /* 여기로 오는 건 대부분 CORS 다. 포도톡 워커의 ALLOW_ORIGIN 에
         podoya.ai.kr 이 없으면 브라우저가 응답을 막아버린다. */
      return { ok: false, error: "서버에 닿지 못했어요 — 워커의 ALLOW_ORIGIN 에 " + location.origin + " 이 있는지 확인해 주세요", cors: 1 };
    });
  }

  /* ── 보낼 글 다듬기 ───────────────────────────────────────── */
  /* @영문 은 포도톡에서 봇 호출로 읽힌다. 브리핑에 @openai 같은 게
     섞이면 엉뚱한 봇이 깨어나므로 전각 ＠ 로 바꾼다. */
  function tame(s) { return String(s == null ? "" : s).replace(/@/g, "＠"); }

  function chunks(s) {
    s = String(s == null ? "" : s);
    if (s.length <= MSG_MAX) return [s];
    var out = [], i = 0;
    while (i < s.length) {
      var end = Math.min(i + MSG_MAX, s.length);
      if (end < s.length) {
        var cut = s.lastIndexOf("\n", end);          /* 줄 단위로 끊는다 */
        if (cut > i + 200) end = cut;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }

  /* 한 방에 여러 조각을 순서대로 (워커 분당 제한을 피해 간격을 둔다) */
  function sendParts(roomId, parts) {
    var uid = myUid();
    return parts.reduce(function (p, part, idx) {
      return p.then(function (acc) {
        if (acc && acc.stop) return acc;
        return new Promise(function (res) { setTimeout(res, idx ? GAP_MS : 0); })
          .then(function () {
            return api("/talk/message", { room_id: roomId, uid: uid, nick: NICK, body: part });
          })
          .then(function (d) {
            if (!d || !d.ok) return { stop: true, error: (d && d.error) || "전송 실패" };
            return { sent: (acc.sent || 0) + 1 };
          });
      });
    }, Promise.resolve({ sent: 0 }));
  }

  /* ══════════════════════════════════════════════════════════
     ① 이동 주소 — pododa.html → podotalk.kr
     ══════════════════════════════════════════════════════════ */
  window.goPodotalkOpen = function () {
    try { window._vansActive = false; } catch (e) {}
    var u = SITE + "/#/talk/direct";
    try { location.assign(u); } catch (e) { location.href = u; }
  };

  /* 음성으로 "○○방에 …라고 보내줘" 한 경우.
     원래는 localStorage 로 글자를 넘겨 입력창에 채웠는데, 도메인이
     달라 그 길이 막혔다. 그래서 먼저 보내고 방을 연다. */
  window.goPodotalk = function (room, msg, ctx) {
    if (!room || !room.id) return;
    try { window._vansActive = false; } catch (e) {}
    var u = SITE + "/#/talk/room/" + PFX + room.id;
    var go = function () { try { location.assign(u); } catch (e) { location.href = u; } };
    if (!msg) { go(); return; }
    say("포도톡으로 보내는 중…");
    sendParts(room.id, chunks(tame(msg))).then(function (r) {
      if (r && r.stop) { say("보내지 못했어요: " + (r.error || "")); return; }
      setTimeout(go, 250);
    });
  };

  /* ══════════════════════════════════════════════════════════
     ② 방 목록 / 방 찾기 / 메시지 보내기 — 서버로 갈아끼운다
     함수 이름과 인자는 그대로 둔다. 부르는 쪽(예약 브리핑·문서
     보관·커넥션·음성 이동)은 한 줄도 고칠 필요가 없다.
     ══════════════════════════════════════════════════════════ */

  /* 원본은 pododa_talk_rooms 를 읽었다. 이제 연결된 방을 돌려준다. */
  window.podotalkRooms = function () {
    return rooms().map(function (r) { return { id: r.id, name: r.name }; });
  };

  /* 이름으로 방 찾기. 없으면 기본 방. 하나도 연결 안 됐으면 빈 값. */
  window.podotalkEnsureRoom = function (name) {
    var a = rooms();
    if (!a.length) return "";
    var n = String(name || "").trim();
    if (n) {
      for (var i = 0; i < a.length; i++) {
        if (String(a[i].name || "").trim() === n) return a[i].id;
      }
    }
    var d = defRoom();
    return d ? d.id : "";
  };

  /* 예약 브리핑 · 문서 보관 · 커넥션 결과가 전부 이리로 온다. */
  window.podotalkPushMsg = function (roomId, text, fromName) {
    if (!roomId) {
      say("포도톡 방이 연결되지 않았어요");
      setTimeout(function () { window.podoyaTalkSetup(); }, 600);
      return false;
    }
    var head = fromName ? ("【" + String(fromName).slice(0, 20) + "】\n") : "";
    var parts = chunks(tame(head + String(text == null ? "" : text)));
    sendParts(roomId, parts).then(function (r) {
      if (r && r.stop) say("포도톡 전송 실패: " + (r.error || ""));
    });
    return true;
  };

  /* ══════════════════════════════════════════════════════════
     ③ 포도톡 방 연결 화면
     ══════════════════════════════════════════════════════════ */
  function closeSetup() {
    var b = document.getElementById("ptl-bg");
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  window.podoyaTalkClose = closeSetup;

  function listHtml() {
    var a = rooms();
    if (!a.length) {
      return '<div style="background:#fafafa;border:1px dashed #ddd;border-radius:12px;padding:18px;' +
             'text-align:center;font-size:13px;color:#999;line-height:1.6">아직 연결된 방이 없어요.<br>' +
             '포도톡에서 방 코드를 복사해 아래에 넣어주세요.</div>';
    }
    var h = "";
    for (var i = 0; i < a.length; i++) {
      var r = a[i], on = !!r.def;
      h += '<div style="display:flex;align-items:center;gap:9px;background:#fff;border:1.5px solid ' +
             (on ? "#c4b5fd" : "#ececec") + ';border-radius:12px;padding:11px 12px;margin-bottom:8px">' +
             '<div style="flex:1;min-width:0">' +
               '<div style="font-size:14px;font-weight:800;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                 esc(r.name) + (on ? ' <span style="font-size:10.5px;color:#7c3aed">기본</span>' : "") +
               '</div>' +
               '<div style="font-size:11.5px;color:#aaa;margin-top:2px">코드 ' + esc(r.code || "-") + '</div>' +
             '</div>' +
             (on ? "" : '<button onclick="podoyaTalkDefault(' + i + ')" style="flex-shrink:0;padding:7px 10px;' +
               'border-radius:9px;border:1px solid #ddd;background:#fff;color:#555;font-size:11.5px;' +
               'font-weight:700;cursor:pointer;font-family:inherit">기본으로</button>') +
             '<button onclick="podoyaTalkRemove(' + i + ')" style="flex-shrink:0;padding:7px 10px;' +
               'border-radius:9px;border:1px solid #f0d0d0;background:#fff;color:#c0392b;font-size:11.5px;' +
               'font-weight:700;cursor:pointer;font-family:inherit">해제</button>' +
           '</div>';
    }
    return h;
  }

  function paint() {
    var el = document.getElementById("ptl-list");
    if (el) el.innerHTML = listHtml();
  }

  /* 토스트는 놓치기 쉽다. 연결 화면 안에도 결과를 남긴다. */
  function note(text, bad) {
    say(text);
    var el = document.getElementById("ptl-msg");
    if (!el) return;
    el.style.display = "block";
    el.style.cssText =
      "display:block;margin-top:10px;border-radius:11px;padding:11px 12px;font-size:12.5px;line-height:1.6;" +
      (bad ? "background:#fff5f5;border:1px solid #f3d0d0;color:#b03030"
           : "background:#f0fdf4;border:1px solid #c8ead4;color:#15803d");
    el.innerHTML = esc(text);
  }

  window.podoyaTalkDefault = function (i) {
    var a = rooms();
    for (var k = 0; k < a.length; k++) a[k].def = (k === i) ? 1 : 0;
    saveRooms(a); paint(); say("기본 방으로 정했어요");
  };

  window.podoyaTalkRemove = function (i) {
    var a = rooms();
    if (i < 0 || i >= a.length) return;
    if (!confirm('"' + a[i].name + '" 연결을 해제할까요?\n(포도톡 방은 지워지지 않아요)')) return;
    var wasDef = a[i].def;
    a.splice(i, 1);
    if (wasDef && a.length) a[0].def = 1;
    saveRooms(a); paint(); say("해제했어요");
  };

  window.podoyaTalkAdd = function () {
    var inp = document.getElementById("ptl-code");
    var code = ((inp && inp.value) || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) { note("방 코드를 넣어주세요", 1); return; }
    var a = rooms();
    for (var i = 0; i < a.length; i++) {
      if (a[i].code === code) { note("이미 연결된 방이에요", 1); return; }
    }
    var btn = document.getElementById("ptl-add");
    if (btn) { btn.disabled = true; btn.textContent = "확인 중…"; }
    api("/talk/room?code=" + encodeURIComponent(code)).then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = "연결"; }
      if (!d || !d.ok || !d.room) { note((d && d.error) || "코드에 맞는 방이 없어요", 1); return; }
      var a2 = rooms();
      a2.push({ id: d.room.id, code: code, name: d.room.name || "포도톡 방", def: a2.length ? 0 : 1 });
      saveRooms(a2);
      if (inp) inp.value = "";
      paint();
      note("✅ " + (d.room.name || "방") + " 연결됨");
    });
  };

  window.podoyaTalkTest = function () {
    var d = defRoom();
    if (!d) { note("먼저 방을 연결해 주세요", 1); return; }
    var btn = document.getElementById("ptl-test");
    if (btn) { btn.disabled = true; btn.textContent = "보내는 중…"; }
    sendParts(d.id, ["[포도야] 연결 확인용 시험 메시지입니다 ✅"]).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = "테스트 발송"; }
      if (r && r.stop) { note("실패: " + (r.error || ""), 1); return; }
      note("✅ 포도톡 \"" + d.name + "\" 방을 확인해 보세요");
    });
  };

  window.podoyaTalkSetup = function () {
    closeSetup();
    var bg = document.createElement("div");
    bg.id = "ptl-bg";
    bg.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.42);display:flex;" +
      "align-items:flex-end;justify-content:center;font-family:inherit";
    bg.onclick = function (e) { if (e.target === bg) closeSetup(); };

    var sheet = document.createElement("div");
    sheet.style.cssText =
      "width:100%;max-width:520px;max-height:88vh;overflow:auto;background:#fff;" +
      "border-radius:20px 20px 0 0;padding:18px 16px 40px;box-sizing:border-box;" +
      "-webkit-overflow-scrolling:touch";

    sheet.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<div style="flex:1;font-size:17px;font-weight:800;color:#111">💬 포도톡 방 연결</div>' +
        '<button onclick="podoyaTalkClose()" style="width:34px;height:34px;border-radius:50%;' +
          'border:1px solid #e5e5e5;background:#fafafa;color:#666;font-size:17px;cursor:pointer;' +
          'font-family:inherit;line-height:1">×</button>' +
      '</div>' +

      '<div style="background:#f4f8ff;border:1px solid #e1e9f6;border-radius:12px;padding:12px 13px;' +
        'font-size:12.5px;color:#3a506e;line-height:1.65;margin-bottom:14px">' +
        '예약 브리핑 · 문서 보관 · 실행 결과를 <b>포도톡 방</b>으로 받습니다.<br>' +
        '포도톡에서 방을 열고 <b>방 코드</b>를 복사해 아래에 붙여넣으세요.' +
      '</div>' +

      '<div id="ptl-list" style="margin-bottom:12px">' + listHtml() + '</div>' +

      '<div style="display:flex;gap:7px;margin-bottom:10px">' +
        '<input id="ptl-code" placeholder="방 코드 (예: A7K2QM)" maxlength="12" ' +
          'autocapitalize="characters" autocomplete="off" spellcheck="false" ' +
          'style="flex:1;min-width:0;box-sizing:border-box;background:#f6f7f8;border:1px solid #e6e6e6;' +
          'border-radius:11px;padding:12px;font-size:14px;color:#111;outline:none;font-family:inherit;' +
          'text-transform:uppercase;letter-spacing:1px">' +
        '<button id="ptl-add" onclick="podoyaTalkAdd()" style="flex-shrink:0;padding:12px 18px;' +
          'border-radius:11px;border:none;background:linear-gradient(135deg,#8b35e0,#a855f7);color:#fff;' +
          'font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">연결</button>' +
      '</div>' +

      '<div style="display:flex;gap:7px">' +
        '<button id="ptl-test" onclick="podoyaTalkTest()" style="flex:1;padding:11px;border-radius:11px;' +
          'border:1px solid #dcdcdc;background:#fff;color:#111;font-size:13.5px;font-weight:700;' +
          'cursor:pointer;font-family:inherit">테스트 발송</button>' +
        '<button onclick="goPodotalkOpen()" style="flex:1;padding:11px;border-radius:11px;' +
          'border:1px solid #dcdcdc;background:#fff;color:#111;font-size:13.5px;font-weight:700;' +
          'cursor:pointer;font-family:inherit">포도톡 열기</button>' +
      '</div>' +

      '<div id="ptl-msg" style="display:none"></div>' +

      '<div id="ptl-bot"></div>' +

      '<details style="margin-top:13px">' +
        '<summary style="font-size:12px;color:#888;cursor:pointer">방 코드는 어디서 받나요?</summary>' +
        '<ol style="margin:8px 0 2px;padding-left:19px;font-size:12px;color:#666;line-height:1.9">' +
          '<li>포도톡에서 방을 하나 만드세요 (예: "포도야 알림")</li>' +
          '<li>방 안 메뉴에서 <b>초대 코드</b>를 복사하세요</li>' +
          '<li>여기에 붙여넣고 연결을 누르세요</li>' +
        '</ol>' +
        '<div style="font-size:11.5px;color:#96a;margin-top:7px;line-height:1.6">' +
          '포도야는 그 방에 <b>' + esc(NICK) + '</b> 이라는 이름으로 참여합니다. ' +
          '참여자 목록에 한 자리가 잡히고, 글이 도착하면 방에 있는 분들께 알림이 갑니다.' +
        '</div>' +
      '</details>';

    bg.appendChild(sheet);
    document.body.appendChild(bg);
    paintBot();
  };

  /* ── 발송 채널 설정 안에 "방 연결" 카드 끼워 넣기 ──────────── */
  /* podoadvf-bg 라는 id 는 다른 고급기능 화면도 같이 쓴다. 그래서
     제목이 "발송 채널" 일 때만 붙인다. 화면이 늦게 그려질 수 있어
     몇 번 다시 확인한다. */
  function hookCard(tries) {
    var bg = document.getElementById("podoadvf-bg");
    if (!bg || bg.children.length < 2) {
      if (tries > 0) setTimeout(function () { hookCard(tries - 1); }, 120);
      return;
    }
    if (document.getElementById("ptl-hook")) return;

    /* 첫 아이는 머리말(제목 줄), 그 뒤가 내용 상자다 */
    var head = bg.children[0];
    var title = (head && (head.innerText || head.textContent) || "");
    if (title.indexOf("발송 채널") < 0) return;   /* 다른 화면이면 붙이지 않는다 */

    var w = null;
    for (var i = 1; i < bg.children.length; i++) {
      if (bg.children[i].nodeType === 1) { w = bg.children[i]; break; }
    }
    if (!w) {
      if (tries > 0) setTimeout(function () { hookCard(tries - 1); }, 120);
      return;
    }

    var d = defRoom(), n = rooms().length;
    var box = document.createElement("div");
    box.id = "ptl-hook";
    box.style.cssText =
      "background:#fff;border:1.5px solid " + (d ? "#c4b5fd" : "#f0d0a0") +
      ";border-radius:14px;padding:14px;margin-bottom:12px";
    box.innerHTML =
      '<div style="font-size:14px;font-weight:800;color:#111">💬 포도톡 방 연결</div>' +
      '<div style="font-size:12.5px;color:#999;margin-top:5px;line-height:1.6">' +
        (d ? ('현재 <b>' + esc(d.name) + '</b> 방으로 갑니다' + (n > 1 ? (" 외 " + (n - 1) + "개 연결됨") : ""))
           : '아직 연결 안 됨 — <b>연결해야 포도톡으로 갑니다</b>') +
      '</div>' +
      '<button onclick="podoyaTalkSetup()" style="width:100%;margin-top:11px;padding:11px;' +
        'border-radius:11px;border:1px solid #dcdcdc;background:#fafafa;color:#111;font-size:13.5px;' +
        'font-weight:700;cursor:pointer;font-family:inherit">' +
        (d ? "방 관리" : "방 연결하기") + '</button>';
    w.insertBefore(box, w.firstChild);
  }

  var _origDeliver = window.openDeliverSettings;
  if (typeof _origDeliver === "function") {
    window.openDeliverSettings = function () {
      _origDeliver.apply(this, arguments);
      hookCard(12);
    };
  }
  /* asDeliver() 가 원본 함수를 직접 붙들고 있을 수도 있으니 한 겹 더 */
  var _origAsDeliver = window.asDeliver;
  if (typeof _origAsDeliver === "function") {
    window.asDeliver = function () {
      _origAsDeliver.apply(this, arguments);
      hookCard(12);
    };
  }

  /* ══════════════════════════════════════════════════════════
     ④ 포도다 — pododa.html → pododa.kr 로 완전히 분리
     같은 폴더의 파일이 아니라 별도 서비스로 대한다. 데이터를
     넘겨주는 다리는 만들지 않는다. 넘길 값은 클립보드로 준다.
     ══════════════════════════════════════════════════════════ */
  function goPododa(hash) {
    try { window._vansActive = false; } catch (e) {}
    var u = PODODA + "/" + (hash || "");
    try { location.assign(u); } catch (e) { location.href = u; }
  }

  /* 격자의 "포도다" 아이콘 */
  window.openPododa = function () { goPododa(""); };

  /* 홈의 "AI매칭 상품등록"(shop) · "상점등록"(food) */
  window.openPododaReg = function (kind) {
    goPododa(kind === "food" ? "#/stores" : "");
  };

  /* 격자는 함수를 배열에 담아두고 누를 때마다 꺼내 쓴다.
     그래서 배열 안의 값을 바꿔주면 아이콘도 새 주소로 간다. */
  try {
    var F = window.PODO_FEATURES;
    if (F && F.length) {
      for (var fi = 0; fi < F.length; fi++) {
        if (F[fi] && F[fi].id === "pododa") F[fi].act = window.openPododa;
      }
    }
  } catch (e) {}

  /* 상품 만들기 화면의 "🍇 포도다에 등록"
     원래는 localStorage 로 상품 정보를 넘겼는데 도메인이 갈려 막혔다.
     원본도 이미 클립보드에 복사하고 있었으므로 붙여넣기로 대신한다.
     안내창 없이 바로 넘어간다(사장님 요청). 복사는 그대로 한다. */
  window.lcToPododa = function () {
    var d = window._lcData;
    if (!d) return;
    try {
      var txt = (typeof window._lcText === "function") ? window._lcText(d)
              : [d.name, d.desc, d.price ? (d.price + "원") : ""].filter(Boolean).join("\n");
      if (navigator.clipboard) navigator.clipboard.writeText(txt);
    } catch (e) {}
    setTimeout(function () { goPododa("#/sell"); }, 700);
  };

  /* ══════════════════════════════════════════════════════════
     ⑤ 죽은 비서 버튼 감추기
     asTalk() · botBack() 은 pododa.html 안의 비서 방으로 가던 것이다.
     포도다와 포도톡이 갈라지면서 갈 곳이 없어졌다. 함수를 비우기만
     하면 눌러도 아무 일이 없는 단추가 남으므로, 단추째 감춘다.
     ══════════════════════════════════════════════════════════ */
  window.asTalk = function () {};
  window.botBack = function () {};

  function hideDead() {
    try {
      var q = document.querySelectorAll('[onclick*="asTalk"],[onclick*="botBack"]');
      for (var i = 0; i < q.length; i++) {
        if (q[i].style.display !== "none") q[i].style.display = "none";
      }
    } catch (e) {}
  }

  try {
    hideDead();
    if (window.MutationObserver) {
      new MutationObserver(hideDead).observe(document.body, { childList: true, subtree: true });
    }
  } catch (e) {}

  /* ══════════════════════════════════════════════════════════
     ⑥ 포도야 비서 양방향 — 포도톡 방 ↔ 포도야 실행기
     ──────────────────────────────────────────────────────────
     포도톡은 손대지 않는다. 포도야가 방을 읽기만 한다.
     원래 설계(확인 후 실행)를 그대로 지킨다:
       포도톡에서 "포도야 …" 라고 쓴다
         → 포도야를 열면 요청함에 쌓인다 (자동 실행 안 함)
         → 사장님이 실행을 누른다
         → 결과가 그 방으로 돌아간다
     🔒 사장님 uid 의 메시지만 받는다. 방에 다른 분이 있어도
        그분 말은 실행기에 닿지 않는다.
     ══════════════════════════════════════════════════════════ */
  var K_OWNER  = "podoya_pt_owner";   /* 사장님 uid */
  var K_CURSOR = "podoya_pt_cursor";  /* 어디까지 읽었나 */
  var K_PAIR   = "podoya_pt_pair";    /* 짝맞추기 번호 */
  var TRIGGER  = /^\s*[\/@]?\s*포도야[\s,·:]+/;

  /* ── 한국말 시각 읽기 ─────────────────────────────────────
     "내일 아침 7시에 …" / "30분 뒤 …" / "오후 3시 …" 를 알아듣는다.
     날짜를 안 적었는데 이미 지난 시각이면 내일로 본다. */
  function parseWhen(text) {
    var now = new Date(), s = String(text || ""), m, cut = "";

    m = s.match(/(\d{1,3})\s*(분|시간)\s*(뒤|후|있다가|지나서)/);
    if (m) {
      var n = parseInt(m[1], 10);
      return { at: now.getTime() + n * (m[2] === "시간" ? 3600000 : 60000), cut: m[0] };
    }

    var dm = s.match(/(오늘|내일|모레|낼)/), day = dm ? dm[1] : "";
    var hh = null, mm = 0, mark = "";
    m = s.match(/(새벽|아침|오전|점심|낮|오후|저녁|밤)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?/);
    if (m) {
      mark = m[1] || ""; hh = parseInt(m[2], 10); mm = m[3] ? parseInt(m[3], 10) : 0;
      cut = (dm ? dm[0] + " " : "") + m[0];
    } else {
      m = s.match(/(\d{1,2}):(\d{2})/);
      if (m) { hh = parseInt(m[1], 10); mm = parseInt(m[2], 10); cut = (dm ? dm[0] + " " : "") + m[0]; }
    }
    if (hh === null || hh > 24 || mm > 59) return null;

    var plus = 0;
    if (mark === "오후" || mark === "저녁" || mark === "밤" || mark === "낮" || mark === "점심") {
      if (hh < 12) hh += 12;
      if (mark === "밤" && hh === 24) { hh = 0; plus = 1; }
    } else if (mark === "새벽" || mark === "아침" || mark === "오전") {
      if (hh === 12) hh = 0;
    }
    if (hh === 24) { hh = 0; plus = 1; }

    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (day === "내일" || day === "낼") d.setDate(d.getDate() + 1);
    else if (day === "모레") d.setDate(d.getDate() + 2);
    d.setDate(d.getDate() + plus);
    if (!day && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return { at: d.getTime(), cut: cut };
  }

  function whenLabel(at) {
    var d = new Date(at), n = new Date();
    var tm = new Date(n.getTime() + 86400000);
    var pre = (d.toDateString() === n.toDateString()) ? "오늘"
            : (d.toDateString() === tm.toDateString()) ? "내일"
            : ((d.getMonth() + 1) + "월 " + d.getDate() + "일");
    var h = d.getHours(), ap = h < 12 ? "오전" : "오후", h12 = (h % 12) || 12;
    var mi = String(d.getMinutes());
    if (mi.length < 2) mi = "0" + mi;
    return pre + " " + ap + " " + h12 + ":" + mi;
  }

  function owner() {
    try { var o = JSON.parse(LS(K_OWNER, "null")); return (o && o.uid) ? o : null; }
    catch (e) { return null; }
  }
  function saveOwner(o) { LSS(K_OWNER, o ? JSON.stringify(o) : ""); }

  /* 요청을 포도야 실행기 큐에 넣는다.
     roomId 를 'podo_bot' 으로 둬야 botNext() 의 이중 방어를 통과한다.
     실제 포도톡 방은 ptRoom 에 따로 적어 회신 때 쓴다. */
  function enqueue(text, ptRoom, nick, runAt) {
    try {
      if (typeof window.botInbox !== "function") return false;
      var a = window.botInbox();
      a.push({
        id: "pt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        roomId: "podo_bot", ptRoom: ptRoom, from: nick || "",
        text: String(text || ""), ts: Date.now(),
        runAt: runAt || 0, status: runAt ? "scheduled" : "queued"
      });
      if (a.length > 20) a = a.slice(-20);
      window.botSaveInbox(a);
      return true;
    } catch (e) { return false; }
  }

  /* 결과 회신 — 원래는 localStorage outbox 에 썼다. 이제 방으로 보낸다. */
  var _origBotReply = window.botReply;
  window.botReply = function (job, text) {
    var rid = (job && job.ptRoom) || (defRoom() && defRoom().id);
    if (!rid) { try { _origBotReply && _origBotReply(job, text); } catch (e) {} return; }
    sendParts(rid, chunks(tame(String(text || "")))).then(function (r) {
      if (r && r.stop) say("결과를 보내지 못했어요: " + (r.error || ""));
    });
  };

  /* 자동 실행은 하지 않는다. 알려만 준다. */
  window.botCheck = function () {
    try {
      var n = 0, a = window.botInbox ? window.botInbox() : [];
      for (var i = 0; i < a.length; i++) if (a[i].status === "queued") n++;
      if (n) say("🍇 포도톡에서 온 요청 " + n + "건이 기다리고 있어요");
    } catch (e) {}
  };

  /* ── 방 읽기 ─────────────────────────────────────────────── */
  var polling = false;

  function pollOnce() {
    var d = defRoom();
    if (!d) return;
    var cur = parseInt(LS(K_CURSOR, "0"), 10) || 0;
    var path = "/talk/messages?room_id=" + encodeURIComponent(d.id) + (cur ? ("&after=" + cur) : "");
    api(path).then(function (r) {
      if (!r || !r.ok || !r.messages) return;
      var list = r.messages, newest = cur;
      for (var i = 0; i < list.length; i++) {
        var m = list[i] || {};
        var ts = parseInt(m.created || 0, 10) || 0;
        if (ts > newest) newest = ts;
        /* 처음 연결한 순간부터 읽는다. 예전 글까지 거슬러 실행하지 않는다. */
        if (!cur) continue;
        handle(m, d.id);
      }
      if (!newest) newest = r.now || Date.now();
      LSS(K_CURSOR, String(newest));
    });
  }

  function handle(m, roomId) {
    var body = String(m.body || "");
    var uid = String(m.uid || "");
    if (!uid || uid === myUid()) return;              /* 포도야 자기 글은 무시 */

    /* 1) 짝맞추기 — 화면에만 보여준 번호를 방에 적으면 그 사람이 사장님 */
    var pair = LS(K_PAIR, "");
    if (pair && body.indexOf(pair) >= 0) {
      saveOwner({ uid: uid, nick: String(m.nick || "사장님").slice(0, 20) });
      LSS(K_PAIR, "");
      paintBot();
      say("✅ 사장님 확인됨 · 이제 \"포도야 …\" 라고 쓰시면 됩니다");
      sendParts(roomId, ["✅ 확인됐어요. 이제 " + '"포도야 ○○해줘"' + " 라고 쓰시면 포도야가 받아둡니다."]);
      return;
    }

    /* 2) 요청 접수 — 🔒 사장님 uid 만 */
    var o = owner();
    if (!o || o.uid !== uid) return;
    if (!TRIGGER.test(body)) return;
    var task = body.replace(TRIGGER, "").trim();
    if (!task) return;

    /* 시각이 적혀 있으면 그때 스스로 돈다. 없으면 확인 후 실행. */
    var w = parseWhen(task);
    if (w) {
      task = task.replace(w.cut, " ").replace(/\s*(에|쯤|경)\s+/, " ").replace(/\s+/g, " ").trim();
      if (!task) return;
      if (enqueue(task, roomId, m.nick, w.at)) {
        paintBot();
        say("⏰ " + whenLabel(w.at) + " 에 하기로 했어요");
        sendParts(roomId, ["⏰ " + whenLabel(w.at) + " 에 " + '"' + task + '"' +
          " 하고 결과를 여기로 보내드릴게요.\n(그 시각에 포도야가 켜져 있어야 해요. 꺼져 있었으면 다음에 열 때 곧바로 합니다)"]);
      }
      return;
    }

    if (enqueue(task, roomId, m.nick)) {
      paintBot();
      say("🍇 요청을 받아뒀어요 · 확인 후 실행해 주세요");
      sendParts(roomId, ["📥 받아뒀어요. 포도야에서 확인하시면 실행하고 결과를 여기로 보내드려요."]);
    }
  }

  /* 때가 된 예약을 돌린다. 예약 브리핑과 같은 "따라잡기" 방식이라,
     그 시각에 폰이 꺼져 있었어도 다음에 열면 곧바로 실행한다.
     한 번에 하나만 돌린다(에이전트가 겹치면 서로 엉킨다). */
  function dueTick() {
    try {
      if (window._botJob) return;                    /* 이미 뭔가 돌고 있다 */
      if (typeof window.botRunJob !== "function") return;
      var a = window.botInbox(), now = Date.now(), j = null;
      for (var i = 0; i < a.length; i++) {
        if (a[i].status === "scheduled" && a[i].runAt && a[i].runAt <= now) { j = a[i]; break; }
      }
      if (!j) return;
      say("⏰ 예약한 일을 시작합니다 · " + String(j.text).slice(0, 24));
      window.botRunJob(j);
    } catch (e) {}
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    setInterval(function () {
      if (document.hidden) return;
      if (!defRoom()) return;
      if (!owner() && !LS(K_PAIR, "")) return;   /* 짝맞추기 전엔 읽지 않는다 */
      pollOnce();
    }, 20000);
    setInterval(dueTick, 30000);                 /* 예약 시계는 방과 상관없이 돈다 */
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      if (defRoom() && (owner() || LS(K_PAIR, ""))) pollOnce();
      dueTick();
    });
    if (defRoom() && (owner() || LS(K_PAIR, ""))) setTimeout(pollOnce, 1500);
    setTimeout(dueTick, 4000);                   /* 열자마자 밀린 예약을 따라잡는다 */
  }

  /* ── 비서 칸 UI ──────────────────────────────────────────── */
  window.podoyaBotPair = function () {
    if (!defRoom()) { note("먼저 방을 연결해 주세요", 1); return; }
    var c = String(Math.floor(100000 + Math.random() * 900000));
    LSS(K_PAIR, c);
    paintBot();
    pollOnce();
  };
  window.podoyaBotUnpair = function () {
    if (!confirm("사장님 확인을 해제할까요?\n포도톡에서 온 요청을 더 이상 받지 않습니다.")) return;
    saveOwner(null); LSS(K_PAIR, ""); paintBot(); say("해제했어요");
  };
  window.podoyaBotRun = function (id) {
    try {
      var a = window.botInbox(), j = null;
      for (var i = 0; i < a.length; i++) if (a[i].id === id) j = a[i];
      if (!j) { note("요청을 찾지 못했어요", 1); return; }
      closeSetup();
      window.botRunJob(j);
    } catch (e) { note("실행하지 못했어요", 1); }
  };
  window.podoyaBotDrop = function (id) {
    try {
      var a = window.botInbox().filter(function (x) { return x.id !== id; });
      window.botSaveInbox(a); paintBot(); say("지웠어요");
    } catch (e) {}
  };

  function botHtml() {
    var o = owner(), pair = LS(K_PAIR, "");
    var h = '<div style="font-size:13.5px;font-weight:800;color:#111;margin:18px 0 8px">🤖 포도톡에서 시키기 <span style="font-size:11px;font-weight:700;color:#aaa">· 선택</span></div>';

    if (pair) {
      h += '<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:13px">' +
             '<div style="font-size:12.5px;color:#92400e;line-height:1.7">포도톡 방에 아래 글을 보내주세요. ' +
             '그 글을 쓴 분을 사장님으로 기억합니다.</div>' +
             '<div style="margin-top:9px;background:#fff;border:1px dashed #d6bd8a;border-radius:10px;padding:12px;' +
             'text-align:center;font-size:17px;font-weight:900;color:#111;letter-spacing:1px">포도야 등록 ' + esc(pair) + '</div>' +
             '<div style="font-size:11px;color:#a98;margin-top:8px;line-height:1.6">이 번호는 방에 보내지 않았습니다. ' +
             '이 화면을 보는 사람만 알 수 있어서, 다른 분이 사장님 행세를 할 수 없습니다.</div>' +
           '</div>';
      return h;
    }

    if (!o) {
      h += '<div style="background:#fafafa;border:1px dashed #ddd;border-radius:12px;padding:14px;font-size:12.5px;' +
             'color:#888;line-height:1.7">포도톡 방에서 <b>"포도야 ○○해줘"</b> 라고 쓰면 포도야가 받아둡니다. ' +
             '확인하고 실행을 누르시면 결과가 그 방으로 돌아옵니다.<br>' +
             '<b>"포도야 내일 아침 7시에 ○○해줘"</b> 처럼 시각을 적으면 그때 스스로 합니다.<br>' +
             '<span style="color:#b45309">쓰기 전에 사장님이 누구인지 한 번 알려주셔야 합니다.</span></div>' +
           '<button onclick="podoyaBotPair()" style="width:100%;margin-top:9px;padding:12px;border-radius:11px;' +
             'border:none;background:linear-gradient(135deg,#8b35e0,#a855f7);color:#fff;font-size:13.5px;' +
             'font-weight:800;cursor:pointer;font-family:inherit">사장님 확인하기</button>';
      return h;
    }

    h += '<div style="display:flex;align-items:center;gap:9px;background:#f0fdf4;border:1.5px solid #c8ead4;' +
           'border-radius:12px;padding:11px 12px">' +
           '<div style="flex:1;min-width:0;font-size:12.5px;color:#15803d;line-height:1.6">✅ 사장님 <b>' + esc(o.nick) + '</b> 확인됨<br>' +
           '<span style="font-size:11px;color:#6a9">이분이 쓴 "포도야 …" 만 받습니다</span></div>' +
           '<button onclick="podoyaBotUnpair()" style="flex-shrink:0;padding:7px 10px;border-radius:9px;' +
             'border:1px solid #f0d0d0;background:#fff;color:#c0392b;font-size:11.5px;font-weight:700;' +
             'cursor:pointer;font-family:inherit">해제</button>' +
         '</div>';

    var all = [];
    try { all = window.botInbox ? window.botInbox() : []; } catch (e) {}
    var sc = all.filter(function (x) { return x.status === "scheduled"; })
                .sort(function (a2, b2) { return (a2.runAt || 0) - (b2.runAt || 0); });
    if (sc.length) {
      h += '<div style="font-size:12px;font-weight:800;color:#555;margin:12px 0 7px">⏰ 예약해둔 일 ' + sc.length + '건</div>';
      for (var s = 0; s < sc.length; s++) {
        h += '<div style="background:#fff;border:1.5px solid #cfe3f8;border-radius:12px;padding:12px;margin-bottom:8px">' +
               '<div style="font-size:11.5px;font-weight:800;color:#1d6fb8">' + esc(whenLabel(sc[s].runAt)) + '</div>' +
               '<div style="font-size:13px;color:#111;line-height:1.6;margin-top:3px;word-break:break-all">' + esc(sc[s].text) + '</div>' +
               '<div style="display:flex;gap:7px;margin-top:10px">' +
                 '<button onclick="podoyaBotRun(\'' + esc(sc[s].id) + '\')" style="flex:2;padding:10px;border-radius:10px;' +
                   'border:1px solid #dcdcdc;background:#fff;color:#111;font-size:12.5px;font-weight:700;' +
                   'cursor:pointer;font-family:inherit">지금 실행</button>' +
                 '<button onclick="podoyaBotDrop(\'' + esc(sc[s].id) + '\')" style="flex:1;padding:10px;border-radius:10px;' +
                   'border:1px solid #f0d0d0;background:#fff;color:#c0392b;font-size:12.5px;font-weight:700;' +
                   'cursor:pointer;font-family:inherit">취소</button>' +
               '</div></div>';
      }
    }

    var q = all.filter(function (x) { return x.status === "queued"; });
    if (q.length) {
      h += '<div style="font-size:12px;font-weight:800;color:#555;margin:12px 0 7px">📥 기다리는 요청 ' + q.length + '건</div>';
      for (var i = 0; i < q.length; i++) {
        h += '<div style="background:#fff;border:1.5px solid #e6e0f6;border-radius:12px;padding:12px;margin-bottom:8px">' +
               '<div style="font-size:13px;color:#111;line-height:1.6;word-break:break-all">' + esc(q[i].text) + '</div>' +
               '<div style="display:flex;gap:7px;margin-top:10px">' +
                 '<button onclick="podoyaBotRun(\'' + esc(q[i].id) + '\')" style="flex:2;padding:10px;border-radius:10px;' +
                   'border:none;background:linear-gradient(135deg,#8b35e0,#a855f7);color:#fff;font-size:12.5px;' +
                   'font-weight:800;cursor:pointer;font-family:inherit">실행</button>' +
                 '<button onclick="podoyaBotDrop(\'' + esc(q[i].id) + '\')" style="flex:1;padding:10px;border-radius:10px;' +
                   'border:1px solid #ddd;background:#fff;color:#666;font-size:12.5px;font-weight:700;' +
                   'cursor:pointer;font-family:inherit">삭제</button>' +
               '</div></div>';
      }
    }
    return h;
  }

  function paintBot() {
    var el = document.getElementById("ptl-bot");
    if (el) el.innerHTML = botHtml();
  }

  try { startPolling(); } catch (e) {}

  /* ══════════════════════════════════════════════════════════
     ⑥ 매일 리포트 — 방 이름을 기억한다
     원본 openRevReport() 는 새 리포트 폼의 방 칸을 늘 "나" 로
     그린다. 값이 코드에 박혀 있다. 그래서 "내방" 으로 고쳐
     저장해도 화면을 다시 열면 "나" 로 보인다. repSave() 가
     끝나며 openRevReport() 를 다시 부르므로 저장 직후에도 그렇다.

     저장된 리포트 자체는 멀쩡하다. 폼의 기본값만 문제다.
     여기서 마지막에 쓴 방 이름을 기억했다가 다시 채워 넣는다.
     기억이 없으면 연결된 기본 방 이름을 쓴다.
     ══════════════════════════════════════════════════════════ */
  var K_RPROOM = "podoya_rp_room";

  function rpRoomDefault() {
    var v = LS(K_RPROOM, "").trim();
    if (v) return v;
    var d = defRoom();
    return (d && d.name) ? String(d.name).trim() : "";
  }

  /* 화면이 늦게 그려질 수 있으니 몇 번 다시 확인한다 */
  function fillRpRoom(tries) {
    var el = document.getElementById("rp-room");
    if (!el) {
      if (tries > 0) setTimeout(function () { fillRpRoom(tries - 1); }, 120);
      return;
    }
    var v = rpRoomDefault();
    if (v) el.value = v;
  }

  var _origOpenRep = window.openRevReport;
  if (typeof _origOpenRep === "function") {
    window.openRevReport = function () {
      _origOpenRep.apply(this, arguments);
      fillRpRoom(12);
    };
  }

  /* 격자 아이콘은 함수를 배열에 미리 담아두고 누를 때 꺼내 쓴다.
     그래서 window 를 덮어써도 그 자리는 옛 함수를 계속 붙들고 있다.
     ④에서 포도다 아이콘에 했던 것과 같은 처리를 여기도 해준다. */
  try {
    var FR = window.PODO_FEATURES;
    if (FR && FR.length) {
      for (var ri = 0; ri < FR.length; ri++) {
        if (FR[ri] && FR[ri].id === "report") FR[ri].act = window.openRevReport;
      }
    }
  } catch (e) {}

  /* 저장할 때 적어둔 방 이름을 기억해 둔다 */
  var _origRepSave = window.repSave;
  if (typeof _origRepSave === "function") {
    window.repSave = function () {
      try {
        var el = document.getElementById("rp-room");
        var v = el ? String(el.value || "").trim() : "";
        if (v) LSS(K_RPROOM, v);
      } catch (e) {}
      return _origRepSave.apply(this, arguments);
    };
  }

  /* ══════════════════════════════════════════════════════════
     ⑦ 알람시계 서버 — 주소를 박아넣고 입력칸을 감춘다
     원본 pushRender() 는 서버 주소 입력칸을 그대로 보여준다.
     그 값은 폰마다 따로 저장되므로 남에게 새지는 않지만, 손님
     폰에서는 늘 비어 있어 아침 알림이 아예 안 온다. 그리고 빈
     칸이 보이면 손님이 아무 주소나 넣을 수 있다.

     그래서 주소는 여기서 정하고, 칸은 지운다. 손님은 "알림 켜기"
     만 누르면 된다.

     🔒 주소가 코드에 박히면 공개 주소가 된다. 무료·유료 한도와
        요청 검사는 워커 쪽에서 해야 한다. 여기서는 못 막는다.
     ══════════════════════════════════════════════════════════ */
  var ALARM   = "https://podoya-alram2.hasin7jk.workers.dev";
  var K_PSRV  = "podoai_push_srv";   /* index.html 의 PUSH_SRV 와 같은 키 */

  /* 저장된 값이 없거나 예전 주소면 지금 주소로 맞춘다 */
  try {
    if (LS(K_PSRV, "").trim() !== ALARM) LSS(K_PSRV, ALARM);
  } catch (e) {}

  /* 입력칸이 들어있는 칸막이 통째로 걷어낸다 (테스트 단추도 그 안에 있다) */
  function stripSrvBox() {
    try {
      var inp = document.getElementById("pn-srv");
      if (!inp) return;
      var box = inp.parentNode;                       /* 입력칸+저장 단추 줄 */
      while (box && box.id !== "pn-box" &&
             String(box.getAttribute("style") || "").indexOf("dashed") < 0) {
        box = box.parentNode;
      }
      if (box && box.id !== "pn-box" && box.parentNode) box.parentNode.removeChild(box);
    } catch (e) {}
  }

  var _origPushRender = window.pushRender;
  if (typeof _origPushRender === "function") {
    window.pushRender = function () {
      _origPushRender.apply(this, arguments);
      stripSrvBox();
    };
  }

  /* pushRender() 를 감싸는 것만으로는 안 잡히는 경우가 있어서
     두 겹을 더 둔다. 어느 하나만 통해도 칸은 사라진다.

     ㉠ CSS 로 미리 숨긴다 — 화면에 그려지는 순간 이미 안 보인다.
        :has() 를 모르는 낡은 브라우저에서는 이 줄이 그냥 무시된다.
     ㉡ 화면이 바뀔 때마다 확인해서 지운다 — 늦게 그려져도 잡힌다. */
  try {
    var st = document.createElement("style");
    st.textContent = "#pn-box > div:has(#pn-srv){display:none!important}";
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}

  try {
    if (window.MutationObserver) {
      new MutationObserver(function () { stripSrvBox(); stripAssistGrape(); })
        .observe(document.documentElement, { childList: true, subtree: true });
    } else {
      setInterval(function () { stripSrvBox(); stripAssistGrape(); }, 700);
    }
  } catch (e) { try { setInterval(stripSrvBox, 700); } catch (e2) {} }

  /* ══════════════════════════════════════════════════════════
     ⑧ 포도야 비서 첫 줄에서 🍇 를 뺀다
     "🍇 준비됐어요 · 바로 시킬 수 있어요" → "준비됐어요 · 바로 시킬 수 있어요"
     아래 "🍇 AI만 켜면 바로 시작돼요" 도 같이 처리된다.

     이모지는 폰이 그리는 글자라 기기마다 모양이 다르다. 그림으로
     바꾸면 줄 높이가 흔들리고 파일 요청이 는다. 그냥 뺀다.

     화면 여는 함수가 배열에 담겨 있어 감싸도 안 잡히므로,
     ⑦의 화면 감시에 얹어 처리한다. 비서 화면 안에서만 손댄다.
     ══════════════════════════════════════════════════════════ */
  function stripAssistGrape() {
    try {
      var bg = document.getElementById("assist-bg");
      if (!bg) return;
      var ds = bg.getElementsByTagName("div");
      for (var i = 0; i < ds.length; i++) {
        var el = ds[i];
        if (el.children.length) continue;              /* 잎사귀 칸만 */
        var t = el.textContent || "";
        if (t.indexOf("🍇") !== 0) continue;
        el.textContent = t.replace(/^🍇\s*/, "");
      }
    } catch (e) {}
  }

  /* ── 준비 확인 ────────────────────────────────────────────── */
  try {
    console.log("🍇 podoya-talk v" + PTL_VER + " · 연결된 방 " + rooms().length + "개 · uid " + myUid());
  } catch (e) {}
})();
