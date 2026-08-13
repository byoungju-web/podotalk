/* ══════════════════════════════════════════════════════════════
   🍇 PT2 레이어 — 포도톡 서버 방 + @봇  (podotalk.kr)
   ──────────────────────────────────────────────────────────────
   원칙 : index.html 안의 기존 코드는 한 줄도 고치지 않는다.
          여기서 전역 함수를 감싸기(wrap)만 한다.
   결정 : ① 서버 방은 "오픈채팅" 탭 안에서 로컬 방과 섞는다
          ② 웹푸시는 podotalk-api 하나만 쓴다
   붙이는 법 : index.html 의 </body> 바로 위에
              <script src="/pt2.js?v=1"></script>
              (고칠 때마다 v=2, v=3 … 으로 올리면 캐시가 안 물린다)

   STEP 로 기능을 단계별로 켠다. 1부터 올리면서 확인하세요.
     1 = 뼈대 + 설정 화면 스위치 (켜기 전엔 지금과 100% 동일)
     2 = 오픈채팅 목록에 서버 방 섞기 (읽기 전용)
     3 = 서버 방 입장 · 전송 · 폴링
     4 = @멘션 봇
     5 = 과제 · 방 전용 봇 만들기
     6 = 웹푸시 (podotalk-api)
     7 = 이 기기 대화를 서버로 올리기 (마이그레이션)
   ══════════════════════════════════════════════════════════════ */
(function () {
"use strict";
if (window.__PT2__) return;
window.__PT2__ = 1;

var STEP = 6;                                            /* ← 1~7 */
var IMPORT_MODE = "bulk";   /* "bulk" = /talk/import 사용(권장) · "replay" = /talk/message 로 재전송 */
var DEF_API = "https://podotalk-api.hasin7jk.workers.dev";
var PFX = "sv_";                                          /* 서버 방 id 접두어 */
var POLL_MS = 3000;

/* ── 원본 보관 (PT 레이어가 이미 감싼 것도 그대로 이어받는다) ── */
var O = {
  renderTalk:         window.renderTalk,
  renderTalkList:     window.renderTalkList,
  renderTalkRoom:     window.renderTalkRoom,
  talkSend:           window.talkSend,
  renderTalkSettings: window.renderTalkSettings
};

/* ══════════════ STEP 1 · 기반 ══════════════ */

/* 원본 localStorage — DBK(나라 접두어)와 sanStore(정화)를 지나지 않는다.
   서버 방은 진실이 서버에 있으므로 나라를 바꿔도 사라지면 안 되고,
   봇 답변의 < > " 가 정화로 지워지면 안 되기 때문이다. */
function LS(k)      { try { return localStorage.getItem(k); } catch (e) { return null; } }
function LSS(k, v)  { try { localStorage.setItem(k, v); } catch (e) {} }
function LSJ(k, d)  { try { var v = JSON.parse(LS(k) || "null"); return v == null ? d : v; } catch (e) { return d; } }

/* ── index4 시절 신원 이어받기 (한 번만) ────────────────────────
   예전 podotalk.kr(index4)은 pt_uid / pt_nick / pt_tokens 를 썼고
   합병본은 pododa_uid / pododa_talk_nick / pt2_tokens 를 쓴다.
   그냥 두면 기존 사용자가 서버에서 다른 사람이 되어
   자기가 만든 방의 방장 권한이 사라진 것처럼 보인다.

   pododa_uid 가 이미 있어도 pt_uid 를 우선한다:
   podotalk.kr 에서 mMe() 를 쓰는 다른 기능(매칭·거래)은
   PT 레이어가 pododa.kr 로 넘겨버리므로 여기서는 채팅 신원만 의미가 있다.
   ────────────────────────────────────────────────────────────── */
(function migrate() {
  if (LS("pt2_migrated") === "1") return;
  try {
    var uid = LS("pt_uid");
    if (uid) LSS("pododa_uid", uid);                    /* 나라 네임스페이스 제외 키라 원본 그대로 */

    var nk = LS("pt_nick");
    if (nk && nk !== "익명") {
      /* 닉네임은 네임스페이스 대상이라 DB 를 거쳐야 나라별 공간에 맞게 들어간다 */
      var cur = null;
      try { cur = DB.get("pododa_talk_nick"); } catch (e) {}
      if (!cur) { try { DB.set("pododa_talk_nick", nk); } catch (e) { LSS("pododa_talk_nick", nk); } }
    }

    var tk = LS("pt_tokens");
    if (tk && !LS("pt2_tokens")) LSS("pt2_tokens", tk); /* 방장 토큰(방 삭제·봇 생성용) */

    var ap = LS("pt_api");
    if (ap && !LS("pt2_api")) LSS("pt2_api", ap);

    /* index4 를 쓰던 기기는 이미 서버 방을 쓰고 있었으므로 서버 모드를 켠 채로 시작한다 */
    if (uid && LS("pt2_on") === null) LSS("pt2_on", "1");
  } catch (e) {}
  LSS("pt2_migrated", "1");
})();

function on()      { return STEP >= 1 && LS("pt2_on") === "1"; }
function apiBase() { return (LS("pt2_api") || DEF_API).replace(/\/+$/, ""); }
function myUid()   { try { return mMe(); } catch (e) { return "u_anon"; } }
function myNick()  { try { return talkNick() || "포도"; } catch (e) { return "포도"; } }
function isSv(id)  { return typeof id === "string" && id.indexOf(PFX) === 0; }
function bare(id)  { return String(id).slice(PFX.length); }
function say(m)    { try { toast(m); } catch (e) {} }
function esc(s)    { try { return escapeHtml(s); } catch (e) { return String(s == null ? "" : s); } }

function tokens()          { return LSJ("pt2_tokens", {}); }
function saveToken(id, t)  { if (!t) return; var o = tokens(); o[id] = t; LSS("pt2_tokens", JSON.stringify(o)); }
function tokenOf(id)       { return tokens()[id] || ""; }

function api(path, opt) {
  opt = opt || {};
  var h = { "Content-Type": "application/json" };
  if (opt.token) h.Authorization = "Bearer " + opt.token;
  return fetch(apiBase() + path, {
    method: opt.body ? "POST" : "GET",
    headers: h,
    body: opt.body ? JSON.stringify(opt.body) : undefined
  }).then(function (r) { return r.json(); })
    .catch(function () { return { ok: false, error: "서버에 연결하지 못했어요" }; });
}

/* 링크와 @이름, **굵게**만 살리고 나머지는 전부 이스케이프한다.
   반드시 이스케이프 뒤에 치환해야 한다. 순서를 바꾸면 저장형 XSS가 된다. */
function rich(s) {
  return esc(s)
    .replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])@([a-z0-9_-]{2,24})/gi, '$1<span class="pt2-at">@$2</span>')
    .replace(/\*\*([^*\n]{1,300})\*\*/g, "<b>$1</b>");
}

/* ── 레이어 전용 CSS ── */
(function style() {
  var css = [
    '.pt2-badge{font-size:10px;font-weight:800;color:#8B7BAE;background:#F1ECFA;padding:1px 5px;border-radius:5px;margin-right:4px}',
    '.pt2-dot{width:8px;height:8px;border-radius:50%;background:#EA580C;display:inline-block}',
    '.pt2-chip{font-size:10.5px;font-weight:800;color:var(--tk-grape);background:var(--tk-soft);padding:2px 6px;border-radius:6px}',
    '.pt2-chip.paid{background:#FFF1DC;color:#9A5B00}',
    '.pt2-botcard{align-self:stretch;background:#fff;border:1px solid var(--tk-line);border-left:3px solid var(--tk-grape);border-radius:5px 14px 14px 5px;overflow:hidden;margin:2px 0}',
    '.pt2-bothead{display:flex;align-items:center;gap:7px;padding:8px 12px;border-bottom:1px solid var(--tk-line);background:linear-gradient(90deg,var(--tk-soft),transparent)}',
    '.pt2-bothead .tag{font-family:var(--mono);font-size:11.5px;font-weight:800;color:var(--tk-grape-d)}',
    '.pt2-bothead .lbl{margin-left:auto;font-size:10.5px;color:var(--tk-sub)}',
    '.pt2-botbody{padding:11px 13px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#241436}',
    '.pt2-botcard.wait .pt2-botbody{color:var(--tk-sub)}',
    '.pt2-dots span{display:inline-block;width:5px;height:5px;margin-right:3px;border-radius:50%;background:var(--tk-grape);animation:pt2blink 1.2s infinite}',
    '.pt2-dots span:nth-child(2){animation-delay:.2s}.pt2-dots span:nth-child(3){animation-delay:.4s}',
    '@keyframes pt2blink{0%,60%,100%{opacity:.25}30%{opacity:1}}',
    '.pt2-at{color:var(--tk-grape);font-weight:800}',
    '.pt2-mentions{position:absolute;left:10px;right:10px;bottom:calc(100% + 4px);background:#fff;border:1px solid var(--tk-line);border-radius:14px;box-shadow:0 -6px 24px rgba(76,29,149,.16);overflow:hidden;max-height:220px;overflow-y:auto;display:none;z-index:40}',
    '.pt2-mentions.on{display:block}',
    '.pt2-mentions .h{padding:7px 13px;font-size:11px;font-weight:800;color:var(--tk-sub);background:var(--tk-soft)}',
    '.pt2-mrow{display:flex;gap:9px;align-items:center;width:100%;text-align:left;padding:10px 13px;border-bottom:1px solid var(--tk-line);background:#fff}',
    '.pt2-mrow:last-child{border-bottom:0}',
    '.pt2-mrow b{font-family:var(--mono);font-size:13px;color:var(--tk-grape-d);display:block}',
    '.pt2-mrow small{display:block;color:var(--tk-sub);font-size:11.5px}',
    '.pt2-task{display:flex;gap:10px;align-items:center;width:100%;text-align:left;padding:12px 0;border-bottom:1px solid var(--tk-line);background:transparent}',
    '.pt2-task .bx{width:22px;height:22px;flex:0 0 auto;border-radius:7px;border:2px solid var(--tk-line);display:flex;align-items:center;justify-content:center;font-size:13px}',
    '.pt2-task.done .bx{background:#10B981;border-color:#10B981;color:#fff}',
    '.pt2-task.done b{text-decoration:line-through;color:var(--tk-sub)}',
    '.pt2-task small{display:block;color:var(--tk-sub);font-size:11.5px}',
    '.pt2-sub{font-size:11.5px;color:var(--tk-sub);margin:-6px 0 10px;line-height:1.6}',
    /* 방 헤더를 화면 상단에 붙박이로. sticky 는 이 스크롤 구조에서
       위로 밀려 사라져 ⚙️ 를 누를 수 없게 된다. */
    '.pt2-fixhead{position:fixed;left:0;right:0;top:0;z-index:30;display:flex;align-items:center;gap:9px;padding:9px 16px;margin:0;background:var(--tk-bg);border-bottom:1px solid var(--tk-line);box-shadow:0 2px 10px rgba(76,29,149,.06)}',
    '.pt2-fixhead .tk-rh-mid{min-width:0;flex:1 1 auto;overflow:hidden}',
    '.pt2-fixhead .tk-hi{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#tkMsgs.pt2-pad{padding-top:62px}',
    /* 설정 맨 아래 버튼이 하단 탭바에 가리지 않도록 여백을 준다 */
    '.tk-set{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px))}'
  ].join("\n");
  var el = document.createElement("style");
  el.setAttribute("data-pt2", "css");
  el.textContent = css;
  document.head.appendChild(el);
})();

/* ══════════════ STEP 1 · 설정 화면에 서버 섹션 붙이기 ══════════════ */
function injectSettings() {
  var box = document.querySelector(".tk-set");
  if (!box || box.querySelector("[data-pt2-sec]")) return;

  var wrap = document.createElement("div");
  wrap.setAttribute("data-pt2-sec", "1");
  wrap.innerHTML =
    '<div class="tk-sec">🌐 서버 연결 (포도톡 방·봇)</div>' +
    '<div class="tk-toggle">서버 방 사용<span class="tk-sw' + (on() ? " on" : "") + '" data-pt2="toggle"></span></div>' +
    '<div class="pt2-sub" style="margin-top:6px">켜면 <b>오픈채팅</b> 탭에서 다른 기기·다른 사람과 실제로 대화하는 방이 함께 보여요. 이 기기에만 저장되는 방에는 <b>📱 이 기기</b> 표시가 붙어요.</div>' +
    '<div class="tk-field" style="margin-top:10px"><label>API 주소</label><input id="pt2Api" value="' + esc(apiBase()) + '" autocomplete="off" autocapitalize="none"></div>' +
    '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="save-api">주소 저장하고 상태 확인</button>' +
    '<div id="pt2Health" class="pt2-sub" style="margin-top:8px"></div>' +
    (STEP >= 6
      ? '<div class="tk-toggle" style="margin-top:10px">🔔 새 메시지 알림<span class="tk-sw" id="pt2PushSw" data-pt2="push"></span></div>' +
        '<button class="cta" style="background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none;margin-top:8px" data-pt2="push-test">알림 테스트 보내기</button>' +
        '<div class="pt2-sub" style="margin-top:6px">이 기기의 알림은 포도톡 서버 하나만 씁니다. 포도다 주문 알림은 pododa.kr 에서 받으세요.</div>'
      : "") +
    (STEP >= 7
      ? '<div class="tk-sec" style="margin-top:14px">📤 이 기기 대화 옮기기</div>' +
        '<div class="pt2-sub">기기에만 저장된 그룹방을 서버로 올리면 다른 기기에서도 같은 방이 보여요. 사진은 올라가지 않습니다.</div>' +
        '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="up-open">옮길 방 고르기</button>'
      : "");
  box.appendChild(wrap);

  if (STEP >= 6) paintPushSwitch();
}

window.renderTalkSettings = function () {
  var r = O.renderTalkSettings.apply(this, arguments);
  try { injectSettings(); } catch (e) {}
  return r;
};

/* ══════════════ STEP 2 · 오픈채팅 목록 섞기 ══════════════ */
function svRooms()      { return LSJ("pt2_rooms", []); }
function saveSvRooms(a) { LSS("pt2_rooms", JSON.stringify(a || [])); }

function svUnread(r) {
  var id = PFX + r.id, ra = 0;
  try { ra = readAt(id); } catch (e) {}
  return (r.last_ts || 0) > ra;
}

function svRoomItem(r) {
  var id = PFX + r.id;
  var last = r.last_body
    ? (r.last_nick ? r.last_nick + ": " : "") + r.last_body
    : (r.intro || "아직 메시지가 없어요");
  var t = "";
  try { t = r.last_ts ? relTime(r.last_ts) : ""; } catch (e) {}
  var kind = ({ general: "일반", study: "스터디", creator: "크리에이터" })[r.type] || "";
  var chips = (kind ? '<span class="pt2-chip">' + kind + "</span>" : "") +
    (r.is_paid ? '<span class="pt2-chip paid">월 ' + Number(r.price || 0).toLocaleString() + "원</span>" : "");
  return '<div class="tk-room" data-action="talk-open" data-id="' + esc(id) + '">' +
      '<div class="tk-av">' + esc(r.emoji || "🍇") + "</div>" +
      '<div class="tk-rmid">' +
        '<div class="tk-rname">' + esc(r.name) +
          '<span class="tk-cnt">👥 ' + (r.members || 1) + "</span>" + chips + "</div>" +
        '<div class="tk-rlast">' + esc(last) + "</div>" +
      "</div>" +
      '<div class="tk-rmeta"><span class="tk-rtime">' + esc(t) + "</span>" +
        (svUnread(r) ? '<span class="pt2-dot"></span>' : "") + "</div>" +
    "</div>";
}

function localOpenItems() {
  var out = [], up = upMap();
  try {
    talkRooms().forEach(function (r) {
      if (tkIsBlocked(r) || tkIsPending(r)) return;
      if (!(r.type === "open" && (r.mode || "group") === "group")) return;
      if (up[r.id]) return;                 /* 서버로 옮긴 방은 서버 쪽 하나만 보인다 */
      var ms = talkMsgs(r.id);
      var ts = ms.length ? ms[ms.length - 1].ts : (r.ts || 0);
      var html = roomListItem(r).replace(
        '<div class="tk-rlast">',
        '<div class="tk-rlast"><span class="pt2-badge">📱 이 기기</span>'
      );
      out.push({ pin: !!r.pinned, ts: ts, html: html });
    });
  } catch (e) {}
  return out;
}

function renderOpen() {
  var items = localOpenItems();
  svRooms().forEach(function (r) {
    items.push({ pin: false, ts: r.last_ts || r.ts || 0, html: svRoomItem(r) });
  });
  items.sort(function (a, b) {
    if (a.pin !== b.pin) return a.pin ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });

  var head = "";
  try { head = tkHeader("오픈채팅", "공개방"); } catch (e) {}
  var say_ =
    '<div class="tk-say">' +
      '<input id="tkSay" class="tk-say-in" placeholder="방 이름 말하거나 입력 → 바로 이동" autocomplete="off">' +
      '<button class="tk-say-mic" data-action="talk-say-mic" id="tkSayMic">🎙️</button>' +
      '<button class="tk-say-go" data-action="talk-say-go">이동</button>' +
    "</div>";
  var tools =
    '<div class="tk-tools">' +
      '<button class="tk-tool primary" data-pt2="new-sv">＋ 방 만들기</button>' +
      '<button class="tk-tool" data-pt2="join-code"># 코드로 입장</button>' +
    "</div>" +
    '<div class="tk-tools" style="margin-top:-6px">' +
      '<button class="tk-tool" data-action="talk-new" data-mode="group">📱 이 기기에만 만들기</button>' +
      '<button class="tk-tool" data-action="talk-join-code">🔑 초대 링크로 입장</button>' +
    "</div>";
  var body = items.length
    ? '<div class="tk-list" id="tkList">' + items.map(function (x) { return x.html; }).join("") + "</div>"
    : '<div class="tk-empty"><div class="ee">💬</div>방이 없어요. 새로 만들어보세요!</div>';

  document.querySelector("#view").innerHTML = head + say_ + tools + body;
  try { setTalkTab("open"); } catch (e) {}
  var sy = document.getElementById("tkSay");
  if (sy) sy.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); try { runTalkSay(); } catch (_e) {} }
  });
}

function refreshRooms(cb) {
  api("/talk/rooms?type=general").then(function (a) {
    api("/talk/rooms?type=study").then(function (b) {
      api("/talk/rooms?type=creator").then(function (c) {
        var all = [].concat(a.rooms || [], b.rooms || [], c.rooms || []);
        var seen = {}, out = [];
        all.forEach(function (r) { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; out.push(r); } });
        saveSvRooms(out);
        if (cb) cb(out);
      });
    });
  });
}

window.renderTalkList = function (kind) {
  if (STEP >= 2 && on() && kind === "open") {
    renderOpen();                                  /* 캐시로 즉시 그리고 */
    refreshRooms(function () {                     /* 서버 응답 오면 다시 */
      if (location.hash.indexOf("#/talk/open") === 0) renderOpen();
    });
    return;
  }
  return O.renderTalkList.apply(this, arguments);
};

/* ══════════════ STEP 3 · 서버 방 입장 · 전송 · 폴링 ══════════════ */
var P = { room: null, id: null, lastTs: 0, timer: null, bots: [] };

function stopPoll() { if (P.timer) { clearInterval(P.timer); P.timer = null; } }
function startPoll() {
  stopPoll();
  P.timer = setInterval(function () {
    if (!document.hidden && P.id) poll(false);
  }, POLL_MS);
}

/* 방을 떠나면 타이머를 끈다. router 는 등록 시점의 참조로 묶여 있어 감싸도 안 먹으므로
   hashchange 를 따로 듣는다. 새 해시가 서버 방이면 건드리지 않는다. */
window.addEventListener("hashchange", function () {
  var m = (location.hash || "").match(/#\/talk\/room\/([\w-]+)/);
  if (!m || !isSv(m[1])) { stopPoll(); P.id = null; P.room = null; }
});
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && P.id) poll(false);
});

function msgHtml(m) {
  var mine = m.uid === myUid();
  var t = "";
  try { t = tkClock(m.created); } catch (e) {}
  if (m.kind === "bot") {
    var icon = "🤖";
    try { icon = JSON.parse(m.meta || "{}").icon || "🤖"; } catch (e) {}
    return '<div class="pt2-botcard"><div class="pt2-bothead"><span>' + esc(icon) + "</span>" +
      '<span class="tag">@' + esc(m.nick) + '</span><span class="lbl">' + esc(t) + "</span></div>" +
      '<div class="pt2-botbody">' + rich(m.body) + "</div></div>";
  }
  if (mine) {
    return '<div class="tk-row me"><div class="tk-bcol"><div class="tk-bub">' + rich(m.body) + "</div></div>" +
      '<span class="tk-time">' + esc(t) + "</span></div>";
  }
  return '<div class="tk-row them"><div class="tk-savatar">🙂</div>' +
    '<div class="tk-bcol"><div class="tk-who">' + esc(m.nick || "익명") + "</div>" +
    '<div class="tk-bub">' + rich(m.body) + "</div></div>" +
    '<span class="tk-time">' + esc(t) + "</span></div>";
}

function append(html) {
  var f = document.getElementById("tkMsgs");
  if (!f) return;
  var sp = document.querySelector("#tkMsgs .tk-spacer");
  if (sp) sp.insertAdjacentHTML("beforebegin", html);
  else f.insertAdjacentHTML("beforeend", html);
  try { tkScrollBottom(); } catch (e) {}
}

function poll(first) {
  if (!P.id) return;
  var q = "/talk/messages?room_id=" + encodeURIComponent(bare(P.id)) + (P.lastTs ? "&after=" + P.lastTs : "");
  return api(q).then(function (d) {
    if (!P.id || !d || !d.messages) return;
    var list = d.messages || [];
    if (first) {
      var f = document.getElementById("tkMsgs");
      if (f && !list.length) {
        f.insertAdjacentHTML("afterbegin",
          '<div class="tk-sys">첫 메시지를 남겨보세요. @summary 처럼 봇을 부르면 답을 해줘요.</div>');
      }
    }
    list.forEach(function (m) {
      if (m.kind === "bot") { var w = document.querySelector(".pt2-botcard.wait"); if (w) w.remove(); }
      var tmp = document.getElementById("pt2tmp");
      if (tmp && m.uid === myUid() && m.kind === "user") { tmp.id = ""; P.lastTs = Math.max(P.lastTs, m.created); return; }
      append(msgHtml(m));
      P.lastTs = Math.max(P.lastTs, m.created);
    });
    if (P.lastTs) { try { setRead(P.id, P.lastTs); } catch (e) {} }
  });
}

function renderRoom(id) {
  stopPoll();
  P.id = id; P.lastTs = 0; P.room = null; P.bots = [];
  var head = "";
  try { head = ""; } catch (e) {}
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead pt2-fixhead"><span class="tk-back" data-action="talk-tab" data-v="open">‹</span>' +
      '<div class="tk-savatar">🍇</div>' +
      '<div class="tk-rh-mid"><div class="tk-hi" id="pt2Title">불러오는 중…</div>' +
        '<div class="tk-hs" id="pt2Sub">서버 방</div></div>' +
      '<div class="tk-racts">' +
        (STEP >= 5 ? '<button class="tk-ract" id="pt2TaskBtn" data-pt2="tasks" style="display:none">✓</button>' : "") +
        '<button class="tk-ract" data-pt2="roomset">⚙️</button>' +
      "</div></div>" +
    '<div class="tk-msgs pt2-pad" id="tkMsgs"><div class="tk-spacer" style="height:calc(70px + env(safe-area-inset-bottom))"></div></div>' +
    '<div class="tk-inputbar">' +
      (STEP >= 4 ? '<div class="pt2-mentions" id="pt2Mentions"></div>' : "") +
      '<div class="tk-inrow">' +
        '<input id="tkInput" placeholder="메시지 입력' + (STEP >= 4 ? " · @로 봇 부르기" : "") + '" autocomplete="off">' +
        '<button class="tk-send" data-action="talk-send" data-id="' + esc(id) + '">➤</button>' +
      "</div></div>";
  try { setTalkTab("open"); } catch (e) {}

  var inp = document.getElementById("tkInput");
  if (inp) {
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); window.talkSend(id); }
    });
    if (STEP >= 4) inp.addEventListener("input", onMention);
  }

  api("/talk/room?id=" + encodeURIComponent(bare(id))).then(function (d) {
    if (!d.ok || !d.room) { say(d.error || "방을 열지 못했어요"); location.hash = "#/talk/open"; return; }
    if (P.id !== id) return;
    /* 목록에서 받아둔 값(type·emoji·code 등)을 밑에 깔고 상세 응답으로 덮는다.
       상세가 얇게 오더라도 스터디 여부 같은 정보가 사라지지 않는다. */
    var cached = null;
    svRooms().forEach(function (x) { if (x.id === bare(id)) cached = x; });
    P.room = Object.assign({}, cached || {}, d.room || {});
    var ttl = document.getElementById("pt2Title");
    var sub = document.getElementById("pt2Sub");
    if (ttl) ttl.textContent = P.room.name || "";
    if (sub) sub.textContent = (P.room.members || 1) + "명 · 코드 " + (P.room.code || "-");
    var tb = document.getElementById("pt2TaskBtn");
    if (tb && P.room.type === "study") tb.style.display = "";
    api("/talk/room/join", { body: { room_id: bare(id), uid: myUid(), nick: myNick() } });
    if (STEP >= 4) loadBots(id);
    poll(true).then(function () { startPoll(); });
  });
}

window.renderTalkRoom = function (id) {
  if (STEP >= 3 && on() && isSv(id)) return renderRoom(id);
  /* 옛 링크·북마크로 들어오면 옮겨간 서버 방으로 보낸다 */
  if (STEP >= 7 && on() && !isSv(id)) {
    var mv = upMap()[id];
    if (mv && mv.sid) { location.replace("#/talk/room/" + PFX + mv.sid); return; }
  }
  stopPoll(); P.id = null;
  return O.renderTalkRoom.apply(this, arguments);
};

function svSend(id) {
  var inp = document.getElementById("tkInput");
  if (!inp) return;
  var text = (inp.value || "").trim();
  if (!text) return;
  inp.value = "";
  var mb = document.getElementById("pt2Mentions");
  if (mb) mb.classList.remove("on");

  append('<div class="tk-row me" id="pt2tmp"><div class="tk-bcol"><div class="tk-bub">' + rich(text) +
    '</div></div><span class="tk-time">전송중</span></div>');

  api("/talk/message", { body: { room_id: bare(id), uid: myUid(), nick: myNick(), body: text } })
    .then(function (d) {
      var tmp = document.getElementById("pt2tmp");
      if (!d.ok) {
        if (tmp) { var s = tmp.querySelector(".tk-time"); if (s) s.textContent = "실패"; }
        say(d.error || "전송하지 못했어요");
        return;
      }
      if (tmp) {
        tmp.id = "";
        var s2 = tmp.querySelector(".tk-time");
        if (s2) { try { s2.textContent = tkClock(d.created); } catch (e) { s2.textContent = ""; } }
      }
      P.lastTs = Math.max(P.lastTs, d.created || 0);
      if (STEP >= 4 && d.bots && d.bots.length) {
        append('<div class="pt2-botcard wait"><div class="pt2-bothead"><span>🤖</span>' +
          '<span class="tag">@' + esc(d.bots.join(", @")) + '</span><span class="lbl">답하는 중</span></div>' +
          '<div class="pt2-botbody"><span class="pt2-dots"><span></span><span></span><span></span></span> 생각하고 있어요</div></div>');
        chaseBot();
      }
    });
}

window.talkSend = function (id) {
  if (STEP >= 3 && on() && isSv(id)) return svSend(id);
  return O.talkSend.apply(this, arguments);
};

/* ══════════════ STEP 4 · @멘션 봇 ══════════════ */
function loadBots(id) {
  api("/mcp/servers?room_id=" + encodeURIComponent(bare(id))).then(function (d) {
    if (P.id === id) P.bots = d.servers || [];
  });
}

function onMention() {
  var inp = document.getElementById("tkInput");
  var box = document.getElementById("pt2Mentions");
  if (!inp || !box) return;
  var head = inp.value.slice(0, inp.selectionStart == null ? inp.value.length : inp.selectionStart);
  var m = head.match(/(?:^|[\s(])@([a-z0-9_-]*)$/i);
  if (!m) { box.classList.remove("on"); return; }
  var q = (m[1] || "").toLowerCase();
  var hit = P.bots.filter(function (b) { return String(b.name || "").indexOf(q) >= 0; }).slice(0, 6);
  if (!hit.length) { box.classList.remove("on"); return; }
  box.innerHTML = '<div class="h">부를 봇을 고르세요</div>' + hit.map(function (b) {
    return '<button class="pt2-mrow" data-pt2="pick-bot" data-n="' + esc(b.name) + '">' +
      "<span>" + esc(b.icon || "🤖") + "</span>" +
      "<span><b>@" + esc(b.name) + "</b><small>" + esc(b.descr || "") + "</small></span></button>";
  }).join("");
  box.classList.add("on");
}

/* 봇 답이 저장되는 즉시 잡으려고 처음엔 촘촘히, 점점 느리게 확인한다 */
function chaseBot() {
  var gaps = [700, 900, 1200, 1600, 2000, 2500, 3000, 4000, 5000];
  var i = 0;
  (function tick() {
    if (!P.id || i >= gaps.length) return;
    setTimeout(function () {
      if (!P.id) return;
      poll(false).then(function () {
        if (document.querySelector(".pt2-botcard.wait")) tick();
      });
    }, gaps[i++]);
  })();
}

/* ══════════════ STEP 5 · 과제 · 방 설정 ══════════════ */
window.renderTalk = function (sub, arg) {
  if (STEP >= 5 && on() && sub === "tasks" && arg) return renderTasks(arg);
  return O.renderTalk.apply(this, arguments);
};

function renderTasks(id) {
  var head = "";
  try { head = tkHeader("과제", "스터디"); } catch (e) {}
  document.querySelector("#view").innerHTML = head +
    '<div class="pt2-sub">이 방에 참여한 모두가 체크할 수 있어요.</div>' +
    '<div class="tk-field"><div id="pt2Tasks">불러오는 중…</div></div>' +
    '<div class="tk-field"><label>새 과제</label><input id="pt2TaskT" maxlength="100" placeholder="예: 3과 단어 외우기" autocomplete="off"></div>' +
    '<button class="cta grape" data-pt2="task-add" data-id="' + esc(id) + '">과제 추가</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="talk-open" data-id="' + esc(id) + '">방으로 돌아가기</button>';
  try { setTalkTab("open"); } catch (e) {}
  drawTasks(id);
}

function drawTasks(id) {
  api("/study/tasks?room_id=" + encodeURIComponent(bare(id))).then(function (d) {
    var el = document.getElementById("pt2Tasks");
    if (!el) return;
    var list = d.tasks || [];
    el.innerHTML = list.length ? list.map(function (t) {
      var due = "";
      try { due = t.due ? new Date(t.due).toLocaleDateString("ko-KR") + "까지" : ""; } catch (e) {}
      return '<button class="pt2-task' + (t.done ? " done" : "") + '" data-pt2="task-toggle" data-tid="' + esc(t.id) + '" data-id="' + esc(id) + '">' +
        '<span class="bx">' + (t.done ? "✓" : "") + "</span>" +
        "<span><b>" + esc(t.title) + "</b><small>" + esc(due + (t.done_by ? " · " + t.done_by : "")) + "</small></span></button>";
    }).join("") : '<div class="pt2-sub">등록된 과제가 없어요.</div>';
  });
}

function roomSetSheet() {
  if (!P.room) return;
  var id = P.id, r = P.room;
  /* 서버가 owner_uid 를 안 돌려주는 경우가 있어서, 이 기기에 방장 토큰이
     저장돼 있으면 방장으로 본다. 토큰은 방을 만든 사람만 받는다. */
  var owner = (r.owner_uid && r.owner_uid === myUid()) || !!tokenOf(bare(id));
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>" + esc(r.name) + "</h3>" +
    '<div class="sd">초대 코드 <b>' + esc(r.code || "-") + "</b> · " + (r.members || 1) + "명 참여 중</div>" +
    '<button class="cta grape" data-pt2="copy-code">초대 코드 복사</button>' +
    (r.type === "study" ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="tasks">✓ 과제 보기</button>' : "") +
    (owner && STEP >= 5 ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="new-agent">🤖 이 방 전용 봇 만들기</button>' : "") +
    (!owner && STEP >= 5 ? '<div class="pt2-sub" style="margin-top:8px">방 전용 봇은 이 방을 만든 기기에서만 추가할 수 있어요.</div>' : "") +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--order);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="leave">방 나가기</button>' +
    (owner ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--order);border:1.5px solid var(--order);box-shadow:none" data-pt2="del-room">방 삭제하기</button>' : "") +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
  bg.setAttribute("data-room", id);
}

function newRoomSheet() {
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  window._pt2New = { type: "general", priv: false };
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>새 방 만들기</h3>" +
    '<div class="sd">서버에 만들어져요. 다른 기기·다른 사람이 초대 코드로 들어올 수 있어요.</div>' +
    '<div class="tk-field"><label>방 이름</label><input id="pt2NName" maxlength="40" placeholder="예: 부산 사장님 모임" autocomplete="off"></div>' +
    '<div class="tk-field"><label>한 줄 소개 (선택)</label><input id="pt2NIntro" maxlength="120" placeholder="무슨 얘기를 하는 방인가요" autocomplete="off"></div>' +
    '<div class="tk-tools" id="pt2NType">' +
      '<button class="tk-tool primary" data-pt2="ntype" data-v="general">일반</button>' +
      '<button class="tk-tool" data-pt2="ntype" data-v="study">스터디</button>' +
      '<button class="tk-tool" data-pt2="ntype" data-v="creator">크리에이터</button>' +
    "</div>" +
    '<div class="tk-toggle">코드로만 입장<span class="tk-sw" id="pt2NPriv" data-pt2="npriv"></span></div>' +
    '<button class="cta grape" style="margin-top:10px" data-pt2="create-sv">방 만들기</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">취소</button>' +
    "</div>";
  document.body.appendChild(bg);
}

/* ══════════════ STEP 6 · 웹푸시 (podotalk-api 하나만) ══════════════ */
function b64u(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - s.length % 4) % 4);
  var raw = atob(s), out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameKey(sub, key) {
  try {
    var a = new Uint8Array(sub.options.applicationServerKey);
    var b = b64u(key);
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch (e) { return false; }
}
function getSub() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve(null);
  return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
    .catch(function () { return null; });
}
function paintPushSwitch() {
  getSub().then(function (s) {
    var sw = document.getElementById("pt2PushSw");
    if (sw) sw.className = "tk-sw" + (s ? " on" : "");
  });
}
function pushOn() {
  if (!("serviceWorker" in navigator)) { say("이 브라우저는 알림을 지원하지 않아요"); return; }
  Notification.requestPermission().then(function (p) {
    if (p !== "granted") { say("기기 설정에서 알림을 허용해 주세요"); return; }
    api("/push/key").then(function (k) {
      if (!k || !k.key) { say("서버에 알림 키가 아직 없어요"); return; }
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (old) {
          /* 예전에 포도다 키로 만든 구독이 남아 있으면 반드시 먼저 해지해야
             다른 키로 subscribe 가 InvalidStateError 없이 성공한다 */
          if (old && !sameKey(old, k.key)) return old.unsubscribe().then(function () { return null; });
          return old;
        }).then(function (cur) {
          if (cur) return cur;
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(k.key) });
        });
      }).then(function (sub) {
        return api("/push/subscribe", { body: { uid: myUid(), sub: sub.toJSON ? sub.toJSON() : sub } });
      }).then(function (r) {
        if (r && r.ok) { say("알림을 켰어요 🔔"); paintPushSwitch(); }
        else say((r && r.error) || "서버에 등록하지 못했어요");
      }).catch(function (e) {
        say("알림 등록 실패: " + (e && e.message ? e.message : e));
      });
    });
  });
}
function pushOff() {
  getSub().then(function (s) {
    if (!s) { paintPushSwitch(); return; }
    api("/push/unsubscribe", { body: { endpoint: s.endpoint } })
      .then(function () { return s.unsubscribe(); })
      .then(function () { say("알림을 껐어요"); paintPushSwitch(); });
  });
}
/* podotalk.kr 에서는 포도다 주문 푸시가 같은 구독 슬롯을 뺏지 못하게 막는다 */
if (STEP >= 6 && /podotalk/.test(location.hostname) && typeof window.pdPushSubscribe === "function") {
  window.pdPushSubscribe = function () {
    return Promise.resolve({ ok: false, why: "포도톡에서는 채팅 알림만 사용해요. 주문 알림은 pododa.kr 에서 켜주세요." });
  };
}

/* ══════════════ STEP 7 · 이 기기 대화를 서버로 올리기 ══════════════
   원칙
   · 그룹 오픈방만 옮긴다. 1:1 대화와 포도야 비서 방은 상대의 서버 신원이
     없어서 옮길 수 없다.
   · 사진은 dataURL 이라 서버로 보내지 않는다. 자리 표시 문구만 남긴다.
   · 원본 로컬 방은 지우지 않는다. 목록에서 감추기만 하고 되돌릴 수 있다.
   ══════════════════════════════════════════════════════════════ */
var CHUNK = 40;

function upMap()      { return LSJ("pt2_uploaded", {}); }
function saveUpMap(o) { LSS("pt2_uploaded", JSON.stringify(o || {})); }

function hash36(s) {
  var h = 5381;
  s = String(s || "");
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function fsizeText(n) {
  n = Number(n || 0);
  if (n > 1048576) return (n / 1048576).toFixed(1) + "MB";
  if (n > 1024) return Math.round(n / 1024) + "KB";
  return n + "B";
}

/* 로컬 메시지 → 서버 메시지 */
function convert(m) {
  var body = String(m.text || "");
  if (m.type === "image")      body = "🖼 사진 (옮기기 전 기기에만 남아 있어요)";
  else if (m.type === "album") body = "🖼 사진 " + ((m.imgs || []).length) + "장 (옮기기 전 기기에만 남아 있어요)";
  else if (m.type === "file")  body = "📎 " + (m.fname || "파일") + " · " + fsizeText(m.fsize);
  if (!body) return null;
  if (body.length > 3000) body = body.slice(0, 3000) + " …(줄임)";
  var mine = m.who === "me";
  var nick = mine ? myNick() : (m.name || "참여자");
  return {
    uid: mine ? myUid() : "u_lc_" + hash36(m.name || "x"),
    nick: nick + (m.ai ? " 🤖" : ""),
    body: body,
    kind: "user",
    created: Number(m.ts) || Date.now(),
    cid: hash36((m.ts || "") + "|" + (m.who || "") + "|" + body.slice(0, 60))
  };
}

function eligible() {
  var up = upMap(), out = [];
  try {
    talkRooms().forEach(function (r) {
      if (!(r.type === "open" && (r.mode || "group") === "group")) return;
      if (typeof BOT_ROOM_ID !== "undefined" && r.id === BOT_ROOM_ID) return;
      var n = 0;
      try { n = talkMsgs(r.id).length; } catch (e) {}
      out.push({ id: r.id, name: r.name, emoji: r.emoji || "🍇", n: n, done: !!up[r.id] });
    });
  } catch (e) {}
  return out;
}

function uploadSheet() {
  var list = eligible();
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var rows = list.length ? list.map(function (x) {
    return '<button class="pt2-task' + (x.done ? " done" : "") + '" data-pt2="up-pick" data-id="' + esc(x.id) + '"' +
      (x.done ? " disabled" : "") + '>' +
      '<span class="bx">' + (x.done ? "✓" : "") + "</span>" +
      "<span><b>" + esc(x.emoji + " " + x.name) + "</b><small>" +
      (x.done ? "이미 옮김" : "메시지 " + x.n + "개") + "</small></span></button>";
  }).join("") : '<div class="pt2-sub">옮길 수 있는 그룹방이 없어요.</div>';

  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>서버로 옮길 방 고르기</h3>" +
    '<div class="sd">고른 방을 서버에 똑같이 만들고 대화를 옮겨요. <b>사진은 올라가지 않고</b> 문구만 남습니다. 1:1 대화와 포도야 비서 방은 옮길 수 없어요.</div>' +
    '<div style="max-height:38vh;overflow-y:auto">' + rows + "</div>" +
    '<div id="pt2UpLog" class="pt2-sub" style="margin-top:10px"></div>' +
    (Object.keys(upMap()).length
      ? '<button class="cta" style="margin-top:10px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="up-undo">옮긴 방 목록에서 되돌리기</button>'
      : "") +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
}

function upLog(t) {
  var el = document.getElementById("pt2UpLog");
  if (el) el.innerHTML = t;
}

/* 한 방을 통째로 올린다 */
function uploadRoom(localId) {
  var r = null;
  try { r = findRoom(localId); } catch (e) {}
  if (!r) { say("방을 찾지 못했어요"); return; }

  var msgs = [];
  try { msgs = talkMsgs(localId) || []; } catch (e) {}
  var conv = msgs.map(convert).filter(Boolean);

  upLog("방을 만드는 중…");
  api("/talk/room/create", { body: {
    name: r.name,
    intro: "이 기기에서 옮겨온 방",
    type: "general",
    uid: myUid(), nick: myNick(),
    is_private: 1,                        /* 옮긴 방은 코드로만 들어오게 한다 */
    emoji: r.emoji || "🍇"
  }}).then(function (d) {
    if (!d.ok) { upLog("방을 만들지 못했어요: " + esc(d.error || "")); return; }
    saveToken(d.id, d.token);
    var sid = d.id, tok = d.token, sent = 0;

    function next() {
      if (sent >= conv.length) {
        var up = upMap();
        up[localId] = { sid: sid, sent: sent, at: Date.now(), name: r.name };
        saveUpMap(up);
        upLog("<b>" + esc(r.name) + "</b> 옮기기 완료 · 메시지 " + sent + "개 ✅<br>초대 코드는 방 안 ⚙️ 에서 볼 수 있어요.");
        refreshRooms(function () {
          if (location.hash.indexOf("#/talk/open") === 0) renderOpen();
        });
        return;
      }
      var part = conv.slice(sent, sent + CHUNK);
      upLog("대화 옮기는 중… " + sent + " / " + conv.length);

      var call;
      if (IMPORT_MODE === "replay") {
        /* 워커를 아직 못 고쳤을 때의 임시 경로.
           시각이 지금으로 바뀌고, @ 가 봇을 부르지 않게 전각으로 바꾼다. */
        call = part.reduce(function (chain, m) {
          return chain.then(function () {
            return api("/talk/message", { body: {
              room_id: sid, uid: m.uid, nick: m.nick,
              body: m.body.replace(/@/g, "＠")
            }});
          });
        }, Promise.resolve()).then(function () { return { ok: true }; });
      } else {
        call = api("/talk/import", { token: tok, body: { room_id: sid, token: tok, messages: part } });
      }

      call.then(function (res) {
        if (!res || !res.ok) {
          upLog("옮기다 멈췄어요: " + esc((res && res.error) || "서버 오류") +
            "<br>이미 올라간 " + sent + "개는 그대로 있습니다. 다시 눌러도 이어서 올라가요.");
          var up2 = upMap();
          up2[localId] = { sid: sid, sent: sent, at: Date.now(), name: r.name, partial: true };
          saveUpMap(up2);
          return;
        }
        sent += part.length;
        next();
      });
    }
    next();
  });
}

/* ══════════════ 클릭 처리 ══════════════ */
document.addEventListener("click", function (e) {
  var el = e.target && e.target.closest ? e.target.closest("[data-pt2]") : null;
  if (!el) return;
  var a = el.getAttribute("data-pt2");

  /* STEP 1 */
  if (a === "toggle") {
    LSS("pt2_on", on() ? "0" : "1");
    stopPoll(); P.id = null;
    say(on() ? "서버 방을 켰어요 🌐" : "서버 방을 껐어요");
    try { renderTalkSettings(); } catch (_e) {}
    return;
  }
  if (a === "save-api") {
    var v = (document.getElementById("pt2Api") || {}).value || "";
    LSS("pt2_api", v.trim() || DEF_API);
    var out = document.getElementById("pt2Health");
    if (out) out.textContent = "확인 중…";
    api("/health").then(function (d) {
      if (!out) return;
      out.innerHTML = d && d.ok
        ? "연결됨 ✅ · AI " + (d.ai ? "켜짐" : "꺼짐") + " · 알림 " + (d.push ? "켜짐" : "꺼짐(VAPID 키 없음)")
        : "연결하지 못했어요. 주소를 확인해 주세요.";
    });
    return;
  }

  /* STEP 2 */
  if (a === "new-sv")   { newRoomSheet(); return; }
  if (a === "ntype")    {
    window._pt2New = window._pt2New || {};
    window._pt2New.type = el.getAttribute("data-v");
    var box = document.getElementById("pt2NType");
    if (box) [].forEach.call(box.children, function (b) { b.className = "tk-tool" + (b === el ? " primary" : ""); });
    return;
  }
  if (a === "npriv")    {
    window._pt2New = window._pt2New || {};
    window._pt2New.priv = !window._pt2New.priv;
    el.className = "tk-sw" + (window._pt2New.priv ? " on" : "");
    return;
  }
  if (a === "create-sv") {
    var nm = ((document.getElementById("pt2NName") || {}).value || "").trim();
    if (!nm) { say("방 이름을 입력해 주세요"); return; }
    var cfg = window._pt2New || { type: "general", priv: false };
    api("/talk/room/create", { body: {
      name: nm,
      intro: ((document.getElementById("pt2NIntro") || {}).value || "").trim(),
      type: cfg.type, uid: myUid(), nick: myNick(),
      is_private: cfg.priv ? 1 : 0,
      emoji: ({ general: "🍇", study: "📚", creator: "✨" })[cfg.type] || "🍇"
    }}).then(function (d) {
      if (!d.ok) { say(d.error || "방을 만들지 못했어요"); return; }
      saveToken(d.id, d.token);
      var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
      say("방을 만들었어요 🍇");
      refreshRooms();
      location.hash = "#/talk/room/" + PFX + d.id;
    });
    return;
  }
  if (a === "join-code") {
    var c = prompt("초대 코드 6자리를 입력하세요");
    if (!c) return;
    api("/talk/room?code=" + encodeURIComponent(c.trim().toUpperCase())).then(function (d) {
      if (!d.ok || !d.room) { say("코드에 맞는 방이 없어요"); return; }
      location.hash = "#/talk/room/" + PFX + d.room.id;
    });
    return;
  }

  /* STEP 4 */
  if (a === "pick-bot") {
    var inp = document.getElementById("tkInput");
    if (inp) {
      inp.value = inp.value.replace(/@[a-z0-9_-]*$/i, "@" + el.getAttribute("data-n") + " ");
      inp.focus();
    }
    var mb = document.getElementById("pt2Mentions"); if (mb) mb.classList.remove("on");
    return;
  }

  /* STEP 5 */
  if (a === "roomset")  { roomSetSheet(); return; }
  if (a === "copy-code"){ try { copyText((P.room && P.room.code) || ""); say("초대 코드를 복사했어요"); } catch (_e) {} return; }
  if (a === "tasks")    {
    var sb2 = document.querySelector(".sheet-bg"); if (sb2) sb2.remove();
    location.hash = "#/talk/tasks/" + (P.id || "");
    return;
  }
  if (a === "task-add") {
    var ti = document.getElementById("pt2TaskT");
    var tt = ((ti || {}).value || "").trim();
    if (!tt) { say("과제 내용을 입력해 주세요"); return; }
    var rid = el.getAttribute("data-id");
    api("/study/task/create", { body: { room_id: bare(rid), title: tt } }).then(function () {
      if (ti) ti.value = "";
      drawTasks(rid); say("과제를 추가했어요");
    });
    return;
  }
  if (a === "task-toggle") {
    var rid2 = el.getAttribute("data-id");
    api("/study/task/toggle", { body: { id: el.getAttribute("data-tid"), nick: myNick() } })
      .then(function () { drawTasks(rid2); });
    return;
  }
  if (a === "new-agent") {
    var bn = prompt("봇 이름을 영문 소문자로 입력하세요 (예: coach)");
    if (!bn) return;
    var bp = prompt("이 봇은 어떤 역할인가요?\n예: 너는 헬스 코치다. 짧고 단호하게 답한다.");
    if (!bp) return;
    var rid3 = P.id;
    api("/talk/agent/create", {
      body: { room_id: bare(rid3), name: bn.toLowerCase(), prompt: bp },
      token: tokenOf(bare(rid3))
    }).then(function (d) {
      if (!d.ok) { say(d.error || "봇을 만들지 못했어요"); return; }
      loadBots(rid3);
      var sb3 = document.querySelector(".sheet-bg"); if (sb3) sb3.remove();
      say("@" + bn.toLowerCase() + " 봇을 만들었어요 🤖");
    });
    return;
  }
  if (a === "leave") {
    api("/talk/room/leave", { body: { room_id: bare(P.id), uid: myUid() } }).then(function () {
      var sb4 = document.querySelector(".sheet-bg"); if (sb4) sb4.remove();
      say("방에서 나왔어요");
      refreshRooms();
      location.hash = "#/talk/open";
    });
    return;
  }
  if (a === "del-room") {
    if (!confirm("방과 모든 대화가 지워져요. 삭제할까요?")) return;
    api("/talk/room/delete", { body: { room_id: bare(P.id) }, token: tokenOf(bare(P.id)) }).then(function (d) {
      if (!d.ok) { say(d.error || "삭제하지 못했어요"); return; }
      var sb5 = document.querySelector(".sheet-bg"); if (sb5) sb5.remove();
      say("방을 삭제했어요");
      refreshRooms();
      location.hash = "#/talk/open";
    });
    return;
  }

  /* STEP 6 */
  if (a === "push")      { getSub().then(function (s) { s ? pushOff() : pushOn(); }); return; }
  if (a === "push-test") { api("/push/test", { body: { uid: myUid() } }).then(function (d) { say(d.ok ? "테스트 알림을 보냈어요" : (d.error || "실패했어요")); }); return; }

  /* STEP 7 */
  if (a === "up-open") {
    if (!on()) { say("먼저 서버 연결을 켜주세요"); return; }
    uploadSheet();
    return;
  }
  if (a === "up-pick") {
    var lid = el.getAttribute("data-id");
    var lr = null; try { lr = findRoom(lid); } catch (_e) {}
    if (!confirm("『" + ((lr && lr.name) || "이 방") + "』을 서버로 옮길까요?\n사진은 올라가지 않고 문구만 남습니다.")) return;
    uploadRoom(lid);
    return;
  }
  if (a === "up-undo") {
    var up3 = upMap();
    var names = Object.keys(up3).map(function (k) { return up3[k].name || k; }).join(", ");
    if (!confirm("옮김 표시를 지울까요?\n(" + names + ")\n\n서버 방은 그대로 있고, 이 기기 원본 방이 목록에 다시 보입니다. 같은 방이 두 개로 보이게 되니 확인용으로만 쓰세요.")) return;
    saveUpMap({});
    var sb6 = document.querySelector(".sheet-bg"); if (sb6) sb6.remove();
    say("되돌렸어요");
    if (location.hash.indexOf("#/talk/open") === 0) renderOpen();
    return;
  }
});

/* 알림을 눌러 들어온 경우: sw.js 가 보내는 room_id 를 서버 방으로 연다 */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "OPEN_ROOM" || !e.data.room_id) return;
    if (!on()) return;
    location.hash = "#/talk/room/" + PFX + e.data.room_id;
  });
}

/* 켜져 있으면 목록을 미리 한 번 받아둔다 */
if (STEP >= 2 && on()) { try { refreshRooms(); } catch (e) {} }

})();
