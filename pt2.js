/* ══════════════════════════════════════════════════════════════
   🍇 PT2 레이어 — 포도톡 서버 방 + @봇  (podotalk.kr)
   ──────────────────────────────────────────────────────────────
   원칙 : index.html 안의 기존 코드는 한 줄도 고치지 않는다.
          여기서 전역 함수를 감싸기(wrap)만 한다.
   결정 : ① 서버 방은 "오픈채팅" 탭 안에서 로컬 방과 섞는다
          ② 웹푸시는 podotalk-api 하나만 쓴다
   붙이는 법 : index.html 의 </body> 바로 위에
              <script src="/pt2.js?v=28"></script>
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

var PT2_VER = "28";
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
    /* 방 헤더와 메시지 목록을 화면에 직접 고정한다.
       #view 스크롤 안에 두면 index5 의 자동 스크롤과 계속 부딪혀
       맨 위까지 올라가지 못한다. 목록에 자체 스크롤을 주면 그 싸움에서 빠진다. */
    '.pt2-fixhead{position:fixed;left:50%;transform:translateX(-50%);width:100%;max-width:430px;box-sizing:border-box;top:0;z-index:30;display:flex;align-items:center;gap:9px;padding:9px 16px;margin:0;background:#fff;border-bottom:1px solid var(--tk-line);box-shadow:0 2px 10px rgba(76,29,149,.06)}',
    '.pt2-fixhead .tk-rh-mid{min-width:0;flex:1 1 auto;overflow:hidden}',
    '.pt2-fixhead .tk-hi{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    /* 목록은 flex 가 아니라 일반 블록이다.
       고정 높이 flex 세로 배치는 자리가 모자라면 자식을 눌러 높이 0 으로 만든다.
       그래서 봇 카드가 얇은 줄로만 남았다. 블록이면 눌릴 수가 없다. */
    '#tkMsgs.pt2-scroll{position:fixed;left:50%;transform:translateX(-50%);width:100%;max-width:430px;box-sizing:border-box;top:70px;bottom:120px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 16px;margin:0;z-index:1;display:block}',
    '#tkMsgs.pt2-scroll > *{flex:0 0 auto;flex-shrink:0;min-height:0;margin-bottom:8px}',
    '#tkMsgs.pt2-scroll > *:last-child{margin-bottom:0}',
    '.pt2-botcard{flex-shrink:0}',
    '.trx-lead{background:#fff;border:1px solid var(--tk-line);border-radius:14px;padding:13px 14px;font-size:12.8px;line-height:1.65;color:var(--tk-sub);margin-bottom:12px}',
    '.trx-lead b{color:var(--tk-grape-d)}',
    '.tk-av.trx-av{background:linear-gradient(135deg,#0ea5e9,#7C3AED);color:#fff}',
    '.trx-pair{margin-left:6px;font-size:12px;letter-spacing:-1px}',
    '.trx-wrap{position:fixed;left:50%;transform:translateX(-50%);width:100%;max-width:430px;box-sizing:border-box;top:70px;bottom:150px;display:flex;flex-direction:column;z-index:1}',
    '.trx-langbar{flex:0 0 auto;display:flex;align-items:flex-end;gap:8px;background:#fff;border-bottom:1px solid var(--tk-line);padding:10px 12px}',
    '.trx-lsel{flex:1;min-width:0}',
    '.trx-lsel label{display:block;font-size:10.5px;font-weight:800;margin:0 0 4px 3px}',
    '.trx-lsel.a label{color:#B45309}.trx-lsel.b label{color:var(--tk-grape-d)}',
    '.trx-lsel select{width:100%;font-family:inherit;font-size:13.5px;font-weight:800;padding:10px 8px;border-radius:12px}',
    '.trx-lsel.a select{background-color:#FEF3C7;border:1.5px solid #FCD34D;color:#92400E}',
    '.trx-lsel.b select{background-color:#EDE9FE;border:1.5px solid #C4B5FD;color:#5B21B6}',
    '.trx-swap{flex:0 0 auto;width:38px;height:38px;margin-bottom:1px;border-radius:50%;border:1.5px solid var(--tk-line);background:#fff;font-size:16px}',
    '.trx-engbar{flex:0 0 auto;display:flex;gap:6px;padding:8px 12px;background:#fff;border-bottom:1px solid var(--tk-line)}',
    '.trx-eng{flex:1;padding:7px 6px;border-radius:10px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-sub);font-size:11.5px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.trx-eng.on{background:var(--tk-soft);border-color:var(--tk-grape);color:var(--tk-grape-d)}',
    '.trx-msgs{flex:1 1 auto;min-height:0;display:block;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px}',
    '.trx-flipnote{flex:0 0 auto;background:#FFF7E8;border-bottom:1px solid #F5E1B8;color:#8a6d2f;font-size:11.5px;font-weight:700;padding:8px 12px;line-height:1.5}',
    '.trx-row{display:flex;margin-bottom:11px}',
    '.trx-row.a{justify-content:flex-end}.trx-row.b{justify-content:flex-start}',
    '.trx-row.flip .trx-b{transform:rotate(180deg)}',
    '.trx-b{max-width:88%;border-radius:16px;padding:11px 13px}',
    '.trx-row.a .trx-b{background:#FEF9E7;border:1.5px solid #FCD34D}',
    '.trx-row.b .trx-b{background:#F5F3FF;border:1.5px solid #C4B5FD}',
    '.trx-who{font-size:11px;font-weight:800;color:var(--tk-sub);margin-bottom:5px}',
    '.trx-lg{font-size:12px}',
    '.trx-src{font-size:12.5px;color:#7b7b8c;line-height:1.5;margin-bottom:5px;word-break:break-word}',
    '.trx-dst{font-size:17px;font-weight:800;line-height:1.5;word-break:break-word}',
    '.trx-row.a .trx-dst{color:#92400E}.trx-row.b .trx-dst{color:#5B21B6}',
    '.trx-dots{margin-left:6px;font-size:11px;opacity:.5}',
    '.trx-foot{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:10.5px;color:var(--tk-sub)}',
    '.trx-foot span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.trx-mini{flex:0 0 auto;border:1px solid var(--tk-line);background:#fff;border-radius:9px;padding:4px 8px;font-size:10.5px;font-weight:800;color:var(--tk-sub)}',
    '.trx-empty{text-align:center;color:var(--tk-sub);font-size:13px;line-height:1.7;padding:44px 10px}',
    '.trx-ee{font-size:38px;margin-bottom:10px}',
    '.trx-bar{position:fixed;bottom:calc(56px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);width:100%;max-width:430px;box-sizing:border-box;background:#fff;border-top:1px solid var(--tk-line);padding:9px 11px 11px;z-index:30}',
    '.trx-turn{display:flex;gap:7px;margin-bottom:7px}',
    '.trx-t{flex:1;padding:9px 6px;border-radius:12px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-sub);font-size:12.5px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.trx-t.on.a{background:#FEF3C7;border-color:#F59E0B;color:#92400E}',
    '.trx-t.on.b{background:#EDE9FE;border-color:var(--tk-grape);color:#5B21B6}',
    '.trx-hint{font-size:11px;color:var(--tk-grape-d);font-weight:700;min-height:14px;margin:0 0 5px 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.trx-inrow{display:flex;gap:7px;align-items:center}',
    '.trx-inrow input{flex:1;min-width:0;border:1.5px solid var(--tk-line);border-radius:22px;padding:11px 15px;font-size:14.5px;font-family:inherit;outline:none;background:#FAF8FF}',
    '.trx-mic,.trx-send{flex:0 0 auto;width:42px;height:42px;border-radius:50%;border:none;font-size:17px}',
    '.trx-mic{background:var(--tk-soft);color:var(--tk-grape-d)}',
    '.trx-mic.rec{background:#EF4444;color:#fff;animation:trxpulse 1s infinite}',
    '@keyframes trxpulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 9px rgba(239,68,68,0)}}',
    '.trx-send{background:var(--tk-grape);color:#fff}',
    '.tk-ract.on{background:var(--tk-soft)}',
    '.trx-set{padding:14px 12px calc(90px + env(safe-area-inset-bottom,0px))}',
    '.trx-set label{display:block;font-size:11.5px;font-weight:800;color:var(--tk-sub);margin:14px 3px 6px}',
    '.trx-set input{width:100%;box-sizing:border-box;border:1.5px solid var(--tk-line);border-radius:12px;padding:12px 14px;font-size:14.5px;font-family:inherit;outline:none}',
    '.trx-set .cta{margin-top:18px}',
    '.trx-set .cta.trx-ghost{background:#fff;color:#EF4444;border:1.5px solid #FCA5A5;box-shadow:none;margin-top:9px}',
    '.pt2-seg{display:flex;background:var(--tk-soft);border-radius:13px;padding:4px;margin:0 0 12px}',
    '.pt2-lrow{display:flex;align-items:center;background:transparent}',
    '.pt2-lrow .tk-room{flex:1;min-width:0}',
    '.pt2-x{flex:0 0 auto;width:34px;height:34px;margin-right:8px;border-radius:11px;background:#F6F1FD;color:#9B8BBE;font-size:14px;font-weight:800}',
    '.pt2-x:active{background:#EFE6FA}',
    '.pt2-seg3 button{font-size:11.5px;padding:8px 2px;line-height:1.35;white-space:normal}',
    '.pt2-seg button{flex:1;padding:10px 6px;border-radius:10px;font-weight:800;font-size:13.5px;color:var(--tk-grape);background:transparent}',
    '.pt2-seg button.on{background:#fff;color:var(--tk-grape-d);box-shadow:0 2px 8px rgba(76,29,149,.10)}',
    '.pt2-mic{background:var(--tk-soft) !important;color:var(--tk-grape-d) !important}',
    '.pt2-mic.rec{background:#EF4444 !important;color:#fff !important;animation:trxpulse 1s infinite}',
    '.pt2-orig{margin-top:6px;padding-top:6px;border-top:1px dashed var(--tk-line);font-size:11.5px;color:var(--tk-sub);line-height:1.5;word-break:break-word}',
    '.pt2-langsel{width:100%;box-sizing:border-box;border:1.5px solid var(--tk-line);border-radius:10px;padding:11px;font-size:14px;font-family:inherit;background:#fff}',
    'body.talk-mode #view{padding-bottom:calc(120px + env(safe-area-inset-bottom,0px))}',
    '.pt2-alarm{padding-bottom:calc(80px + env(safe-area-inset-bottom,0px))}',
    '.tk-al{cursor:pointer}',
    '.tk-al:active{opacity:.7}',
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
    '<div class="pt2-sub" style="margin-top:4px">레이어 버전 <b>PT2 v' + PT2_VER + "</b></div>" +
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

/* 오픈채팅 탭 = [ 오픈채팅 | 상점톡 ] 두 칸.
   상점톡은 예전 '일반채팅'(가게·판매자와의 1:1)을 그대로 옮긴 것이다. */
function seg() { return LS("pt2_seg") === "shop" ? "shop" : "open"; }

function shopItems() {
  var out = [];
  try {
    talkRooms().forEach(function (r) {
      if (tkIsBlocked(r) || tkIsPending(r)) return;
      if (r.type === "open" || r.type === "bot") return;   /* 오픈방·비서는 여기 아님 */
      var ms = talkMsgs(r.id);
      var ts = ms.length ? ms[ms.length - 1].ts : (r.ts || 0);
      out.push({ pin: !!r.pinned, ts: ts, html: roomListItem(r) });
    });
  } catch (e) {}
  return out;
}

function renderOpen() {
  var cur = seg();
  var items = (cur === "shop") ? shopItems() : localOpenItems();
  if (cur === "open") {
    svRooms().forEach(function (r) {
      if (isLive(r.id)) return;          /* 동시통역방은 통역톡 탭에서만 보인다 */
      items.push({ pin: false, ts: r.last_ts || r.ts || 0, html: svRoomItem(r) });
    });
  }
  items.sort(function (a, b) {
    if (a.pin !== b.pin) return a.pin ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });

  var head = "";
  try { head = tkHeader(cur === "shop" ? "상점톡" : "오픈채팅", cur === "shop" ? "가게" : "공개방"); } catch (e) {}
  var segBar =
    '<div class="pt2-seg">' +
      '<button class="' + (cur === "open" ? "on" : "") + '" data-pt2="seg" data-v="open">🗨️ 오픈채팅</button>' +
      '<button class="' + (cur === "shop" ? "on" : "") + '" data-pt2="seg" data-v="shop">🏪 상점톡</button>' +
    "</div>";
  var say_ =
    '<div class="tk-say">' +
      '<input id="tkSay" class="tk-say-in" placeholder="방 이름 말하거나 입력 → 바로 이동" autocomplete="off">' +
      '<button class="tk-say-mic" data-action="talk-say-mic" id="tkSayMic">🎙️</button>' +
      '<button class="tk-say-go" data-action="talk-say-go">이동</button>' +
    "</div>";
  var tools = (cur === "shop") ? "" :
    '<div class="tk-tools">' +
      '<button class="tk-tool primary" data-pt2="new-sv">＋ 방 만들기</button>' +
      '<button class="tk-tool" data-pt2="join-code"># 코드로 입장</button>' +
    "</div>" +
    '<div class="tk-tools" style="margin-top:-6px">' +
      '<button class="tk-tool" data-action="talk-new" data-mode="group">📱 이 기기에만 만들기</button>' +
      '<button class="tk-tool" data-action="talk-join-code">🔑 초대 링크로 입장</button>' +
    "</div>";
  var empty = (cur === "shop")
    ? '<div class="tk-empty"><div class="ee">🏪</div>가게와 나눈 대화가 없어요.<br>상점에서 문의하기를 누르면 여기에 생겨요.</div>'
    : '<div class="tk-empty"><div class="ee">💬</div>방이 없어요. 새로 만들어보세요!</div>';
  var body = items.length
    ? '<div class="tk-list" id="tkList">' + items.map(function (x) { return x.html; }).join("") + "</div>"
    : empty;

  document.querySelector("#view").innerHTML = head + segBar + say_ + tools + body;
  markTab("open");
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
  if (STEP >= 2 && (kind === "open" || kind === "general")) {
    if (kind === "general") LSS("pt2_seg", "shop");   /* 옛 '일반채팅' 진입 → 상점톡 칸 */
    renderOpen();                                    /* 캐시로 즉시 그리고 */
    if (on()) refreshRooms(function () {              /* 서버 응답 오면 다시 */
      if (location.hash.indexOf("#/talk/open") === 0 || location.hash === "#/talk") renderOpen();
    });
    return;
  }
  return O.renderTalkList.apply(this, arguments);
};

/* ══════════════ STEP 3 · 서버 방 입장 · 전송 · 폴링 ══════════════ */
var P = { room: null, id: null, sig: "", timer: null, bots: [], waiting: false, waitSince: 0, waitNames: "" };

/* index5 는 화면 크기가 바뀔 때마다 채팅방을 맨 아래로 끌어내린다(#view 를 스크롤).
   서버 방은 목록이 자체 스크롤을 가지므로 그 동작이 끼어들 필요가 없고,
   끼어들면 위로 올라가려는 손가락과 계속 싸운다. 그래서 방에 있는 동안 막는다. */
var _tkSB = window.tkScrollBottom;
window.tkScrollBottom = function () {
  if (P.id) return;                               /* 서버 방에 있는 동안은 무시 */
  return _tkSB.apply(this, arguments);
};
function msgsEl()   { return document.getElementById("tkMsgs"); }
function nearBottom() {
  var m = msgsEl();
  if (!m) return true;
  return (m.scrollHeight - m.scrollTop - m.clientHeight) < 160;
}
function doScroll() {
  /* 목록 자체 스크롤이므로 index5 의 전역 스크롤 함수는 쓰지 않는다 */
  function go() { var m = msgsEl(); if (m) m.scrollTop = m.scrollHeight + 9999; }
  go();
  requestAnimationFrame(go);
  [60, 200, 500, 900].forEach(function (ms) { setTimeout(go, ms); });
}

/* 헤더 높이와 입력바 위치는 기기 글자 크기·키보드 상태에 따라 달라진다.
   고정값을 쓰면 맨 위 메시지가 헤더 밑에 깔리거나 아래가 잘린다. 그래서 직접 잰다. */
function fitHead() {
  var h = document.querySelector(".pt2-fixhead");
  var m = msgsEl();
  if (!h || !m) return;
  m.style.top = h.offsetHeight + "px";
  var bar = document.querySelector(".tk-inputbar");
  var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  if (bar) {
    var r = bar.getBoundingClientRect();
    m.style.bottom = Math.max(0, Math.round(vh - r.top)) + "px";
  }
}
window.addEventListener("resize", function () { if (P.id) fitHead(); });
try {
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { if (P.id) fitHead(); });
  }
} catch (e) {}

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
  if (!m || !isSv(m[1])) { stopPoll(); pt2MicStop(); P.id = null; P.room = null; }
});
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && P.id) poll(false);
});

function msgHtml(m) {
  var mine = m.uid === myUid();
  var t = "";
  try { t = tkClock(m.created); } catch (e) {}

  /* 남이 쓴 글은 자동번역을 시도한다. 원문은 아래에 작게 남긴다 */
  var tr = mine ? null : trFor(m.body);
  var main = (tr && tr.text) ? tr.text : m.body;
  var sub = "";
  if (tr && tr.text) sub = '<div class="pt2-orig">' + esc(m.body) + "</div>";
  else if (tr && tr.pending) sub = '<div class="pt2-orig">🌐 번역 중…</div>';

  if (m.kind === "bot") {
    var icon = "🤖";
    try { icon = JSON.parse(m.meta || "{}").icon || "🤖"; } catch (e) {}
    return '<div class="pt2-botcard"><div class="pt2-bothead"><span>' + esc(icon) + "</span>" +
      '<span class="tag">@' + esc(m.nick) + '</span><span class="lbl">' + esc(t) + "</span></div>" +
      '<div class="pt2-botbody">' + rich(main) + sub + "</div></div>";
  }
  if (mine) {
    return '<div class="tk-row me"><div class="tk-bcol"><div class="tk-bub">' + rich(m.body) + "</div></div>" +
      '<span class="tk-time">' + esc(t) + "</span></div>";
  }
  return '<div class="tk-row them"><div class="tk-savatar">🙂</div>' +
    '<div class="tk-bcol"><div class="tk-who">' + esc(m.nick || "익명") + "</div>" +
    '<div class="tk-bub">' + rich(main) + sub + "</div></div>" +
    '<span class="tk-time">' + esc(t) + "</span></div>";
}

function append(html) {
  var f = msgsEl();
  if (f) f.insertAdjacentHTML("beforeend", html);
}


/* ══════════════ 서버 방 자동번역 ══════════════
   각자 자기 폰에서 '내 언어'만 고르면, 남이 쓴 글이 내 언어로 번역돼 보인다.
   서버에는 원문만 저장된다. 번역은 각 폰이 직접 하고 결과는 이 기기에 쌓아둔다.
   그래서 워커를 고칠 필요가 없고, 같은 문장은 두 번 번역하지 않는다. */
function trOn(id){ return LS("pt2_tr_" + bare(id || P.id || "")) === "1"; }
function trSetOn(id, v){ LSS("pt2_tr_" + bare(id), v ? "1" : "0"); }
function myLang(){ return LS("pt2_tr_lang") || "KO"; }
/* 처음 한 번은 한국어로 맞춰둔다. 이후 직접 고른 값은 그대로 지킨다 */
(function(){ if (LS("pt2_lang_init") !== "1") { LSS("pt2_tr_lang", "KO"); LSS("pt2_lang_init", "1"); } })();
function setMyLang(v){ LSS("pt2_tr_lang", v); }

function trCache(){ return LSJ("pt2_tr_cache", {}); }
function trCacheSave(o){
  var k = Object.keys(o);
  if (k.length > 500) { var t = {}; k.slice(-400).forEach(function (x) { t[x] = o[x]; }); o = t; }
  LSS("pt2_tr_cache", JSON.stringify(o));
}

/* 글자만 보고 어느 문자인지 가른다. 같은 문자면 번역할 필요가 없다 */
function scriptOf(s){
  s = String(s || "");
  if (/[가-힣]/.test(s)) return "ko";
  if (/[\u3040-\u30ff]/.test(s)) return "ja";
  if (/[\u4e00-\u9fff]/.test(s)) return "zh";
  if (/[\u0400-\u04ff]/.test(s)) return "cy";
  if (/[\u0600-\u06ff]/.test(s)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(s)) return "th";
  if (/[\u0900-\u097f]/.test(s)) return "dv";
  if (/[\u1000-\u109f]/.test(s)) return "my";
  if (/[\u1780-\u17ff]/.test(s)) return "km";
  if (/[\u0590-\u05ff]/.test(s)) return "he";
  if (/[\u0980-\u09ff]/.test(s)) return "bn";
  return "la";
}
function scriptOfLang(c){
  var m = { KO:"ko", JA:"ja", ZH:"zh", RU:"cy", UK:"cy", MN:"cy",
            AR:"ar", TH:"th", HI:"dv", NE:"dv", MY:"my", KM:"km", HE:"he", BN:"bn" };
  return m[c] || "la";
}

var trQ = [], trBusy = false, trSeen = {}, trPaint = null;
function trEnqueue(text, tgt, key){
  if (trSeen[key]) return;
  trSeen[key] = 1;
  trQ.push({ text: text, tgt: tgt, key: key });
  if (!trBusy) trStep();
}
function trStep(){
  var job = trQ.shift();
  if (!job) { trBusy = false; return; }
  trBusy = true;
  var done = function (out){
    if (out) {
      var c = trCache(); c[job.key] = out; trCacheSave(c);
      if (trPaint) clearTimeout(trPaint);
      trPaint = setTimeout(function () { renderMsgs(P.list || [], false); }, 180);
    }
    setTimeout(trStep, 60);
  };
  /* 보낸 사람 언어를 모르므로 자동 감지가 되는 무료 번역을 먼저 쓴다 */
  trxGoogle(job.text, "auto", trxG(job.tgt), done, function () {
    trxAI(job.text, "EN", job.tgt, function (o) { done(o); });
  });
}

/* 이 메시지를 내 언어로 바꾼 결과. 아직 없으면 줄 세우고 '번역 중'을 돌려준다 */
function trFor(text){
  if (!P.id || !trOn(P.id) || !text) return null;
  var tgt = myLang();
  var sc = scriptOf(text);
  if (sc !== "la" && sc === scriptOfLang(tgt)) return null;   /* 이미 내 문자 */
  var key = tgt + "|" + hash36(text);
  var c = trCache()[key];
  if (c) return { text: c };
  trEnqueue(text, tgt, key);
  return { pending: true };
}


/* ── 방마다 알림 끄기 ──
   서비스워커는 localStorage 를 못 읽는다. 그래서 꺼둔 방 목록을
   캐시에 적어두고, 알림이 올 때 워커가 그걸 읽어 걸러낸다. */
function mutedList(){ return LSJ("pt2_mute", []); }
function muted(sid){ return mutedList().indexOf(String(sid)) >= 0; }
function setMuted(sid, v){
  var a = mutedList(), i = a.indexOf(String(sid));
  if (v && i < 0) a.push(String(sid));
  if (!v && i >= 0) a.splice(i, 1);
  LSS("pt2_mute", JSON.stringify(a));
  try {
    if (window.caches) caches.open("pt2-cfg").then(function (c) {
      c.put("/__pt2_mute", new Response(JSON.stringify(a), { headers: { "Content-Type": "application/json" } }));
    });
  } catch (e) {}
}
try { setMuted("", false); } catch (e) {}   /* 처음 실행 때 캐시에 목록을 한 번 써둔다 */

function waitCard() {
  return '<div class="pt2-botcard wait"><div class="pt2-bothead"><span>🤖</span>' +
    '<span class="tag">@' + esc(P.waitNames || "bot") + '</span><span class="lbl">답하는 중</span></div>' +
    '<div class="pt2-botbody"><span class="pt2-dots"><span></span><span></span><span></span></span> 생각하고 있어요</div></div>';
}

/* 목록을 통째로 다시 그린다.
   예전에는 after= 로 새 메시지만 받아 이어붙였는데, 서버가 그 조건을
   다르게 해석하면 봇 답변이 영영 안 들어온다(알림만 오고 화면은 빈다).
   전체를 받아 그대로 그리면 그 문제가 원천적으로 사라진다. */
function renderMsgs(list, force) {
  var m = msgsEl();
  if (!m) return;
  P.list = list || P.list || [];
  var near = nearBottom();
  var html = (P.list || []).map(msgHtml).join("");
  if (!html) html = '<div class="tk-sys">첫 메시지를 남겨보세요. @summary 처럼 봇을 부르면 답을 해줘요.</div>';
  if (P.waiting) html += waitCard();
  m.innerHTML = html;
  if (force || near) doScroll();
}

function poll(first) {
  if (!P.id) return Promise.resolve();
  return api("/talk/messages?room_id=" + encodeURIComponent(bare(P.id))).then(function (d) {
    if (!P.id || !d || !d.messages) return;
    var list = d.messages || [];
    var last = list.length ? list[list.length - 1] : null;

    /* 봇 답이 들어왔으면 '답하는 중' 카드를 내린다 */
    if (P.waiting) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].kind === "bot" && (list[i].created || 0) >= (P.waitSince || 0)) { P.waiting = false; break; }
      }
      if (P.waiting && Date.now() - (P.waitSince || 0) > 90000) P.waiting = false;   /* 90초 넘으면 포기 */
    }

    var sig = list.length + "|" + (last ? (last.id || last.created) : "") + "|" + (P.waiting ? 1 : 0);
    if (!first && sig === P.sig) return;              /* 바뀐 게 없으면 다시 그리지 않는다 */
    P.sig = sig;
    renderMsgs(list, first);
    if (last && last.created) { try { setRead(P.id, last.created); } catch (e) {} }
  });
}


/* ── 서버 방 받아쓰기 : 내 언어로 말하면 그대로 글이 되어 전송된다 ── */
var pt2Rec = null;
function pt2MicStop(){
  if (pt2Rec) { try { pt2Rec.stop(); } catch (e) {} }
  pt2Rec = null;
  var b = document.getElementById("pt2Mic");
  if (b) b.classList.remove("rec");
}
function pt2MicStart(id){
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { say("이 브라우저는 받아쓰기를 지원하지 않아요"); return; }
  if (pt2Rec) { pt2MicStop(); return; }
  var lang = myLang();
  try {
    pt2Rec = new SR();
    pt2Rec.lang = trxBcp(lang);
    pt2Rec.interimResults = true;
    pt2Rec.continuous = false;
    var got = "";
    pt2Rec.onresult = function (ev) {
      var it = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) got += t; else it += t;
      }
      var inp = document.getElementById("tkInput");
      if (inp) inp.value = (got + it).trim();
    };
    pt2Rec.onerror = function () { pt2MicStop(); };
    pt2Rec.onend = function () {
      var inp = document.getElementById("tkInput");
      var v = inp ? (inp.value || "").trim() : "";
      pt2MicStop();
      if (v) window.talkSend(id);          /* 말이 끝나면 바로 보낸다 */
    };
    pt2Rec.start();
    var b = document.getElementById("pt2Mic");
    if (b) b.classList.add("rec");
    say("🎙️ " + trxFlag(lang) + " " + trxName(lang) + "로 듣는 중… 말이 끝나면 자동으로 보내요");
  } catch (e) { pt2MicStop(); say("마이크를 시작할 수 없어요"); }
}

function renderRoom(id) {
  stopPoll();
  P.id = id; P.sig = ""; P.room = null; P.bots = [];
  P.waiting = false; P.waitSince = 0; P.waitNames = "";
  var head = "";
  try { head = ""; } catch (e) {}
  var backTo = isLive(bare(id))
    ? '<span class="tk-back" data-pt2="lang">‹</span>'
    : '<span class="tk-back" data-action="talk-tab" data-v="open">‹</span>';
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead pt2-fixhead">' + backTo +
      '<div class="tk-savatar">🍇</div>' +
      '<div class="tk-rh-mid"><div class="tk-hi" id="pt2Title">불러오는 중…</div>' +
        '<div class="tk-hs" id="pt2Sub">서버 방</div></div>' +
      '<div class="tk-racts">' +
        '<button class="tk-ract" data-pt2="top" title="맨 위로">⤒</button>' +
        (STEP >= 5 ? '<button class="tk-ract" id="pt2TaskBtn" data-pt2="tasks" style="display:none">✓</button>' : "") +
        '<button class="tk-ract" data-pt2="roomset">⚙️</button>' +
      "</div></div>" +
    '<div class="tk-msgs pt2-scroll" id="tkMsgs"></div>' +
    '<div class="tk-inputbar">' +
      (STEP >= 4 ? '<div class="pt2-mentions" id="pt2Mentions"></div>' : "") +
      '<div class="tk-inrow">' +
        '<input id="tkInput" placeholder="' + esc(isLive(bare(id)) ? (trxName(myLang()) + "로 말하거나 입력하세요") : ("메시지 입력" + (STEP >= 4 ? " · @로 봇 부르기" : ""))) + '" autocomplete="off">' +
        '<button class="tk-send pt2-mic" id="pt2Mic" data-pt2="mic" data-id="' + esc(id) + '">🎙️</button>' +
        '<button class="tk-send" data-action="talk-send" data-id="' + esc(id) + '">➤</button>' +
      "</div></div>";
  markTab(isLive(bare(id)) ? "lang" : "open");
  fitHead();
  requestAnimationFrame(fitHead);          /* 폰트 적용 뒤 한 번 더 */

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
    if (ttl) ttl.textContent = roomLabel(bare(id), P.room.name);
    if (sub) sub.textContent = (P.room.members || 1) + "명 · 코드 " + (P.room.code || "-") +
      (trOn(id) ? " · 🌐 " + trxName(myLang()) : "");
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

  /* 서버가 bots 를 안 돌려줘도 답을 기다리도록, @이름은 내가 직접 읽는다 */
  var mentions = [];
  if (STEP >= 4) {
    var mm = text.match(/(?:^|[\s(])@([a-z0-9_-]{2,24})/gi) || [];
    mentions = mm.map(function (x) { return x.replace(/^[\s(]*@/, ""); });
  }

  append('<div class="tk-row me"><div class="tk-bcol"><div class="tk-bub">' + rich(text) +
    '</div></div><span class="tk-time">전송중</span></div>');
  doScroll();

  api("/talk/message", { body: { room_id: bare(id), uid: myUid(), nick: myNick(), body: text } })
    .then(function (d) {
      if (!d || !d.ok) { say((d && d.error) || "전송하지 못했어요"); poll(true); return; }
      var names = (d.bots && d.bots.length) ? d.bots : mentions;
      if (STEP >= 4 && names.length) {
        P.waiting = true;
        P.waitSince = d.created || Date.now();
        P.waitNames = names.join(", @");
        chaseBot();
      }
      P.sig = "";                    /* 강제로 다시 그리게 */
      poll(true);
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
        if (P.waiting) tick();          /* 아직 답이 안 왔으면 계속 확인 */
      });
    }, gaps[i++]);
  })();
}

/* ══════════════ 하단 탭 재구성 ══════════════
   쇼핑 · 채팅 · 통역톡 · 오픈채팅 · 설정 (5칸 유지)
   기존 '일반채팅'은 오픈채팅 안의 '상점톡' 칸으로 옮긴다.
   index.html 은 건드리지 않고 여기서 버튼만 다시 그린다. */
function fixTabbar() {
  var bar = document.getElementById("talkbar");
  if (!bar || bar.getAttribute("data-pt2") === "1") return;
  bar.setAttribute("data-pt2", "1");
  bar.innerHTML =
    '<button data-action="nav" data-to="#/" id="tk-tab-home"><span class="ti">🏠</span>쇼핑</button>' +
    '<button data-action="talk-tab" data-v="direct" id="tk-tab-direct"><span class="ti">💬</span>채팅</button>' +
    '<button data-pt2="lang" id="tk-tab-lang"><span class="ti">🌐</span>통역톡</button>' +
    '<button data-action="talk-tab" data-v="open" id="tk-tab-open"><span class="ti">🗨️</span>오픈채팅</button>' +
    '<button data-action="talk-tab" data-v="settings" id="tk-tab-settings"><span class="ti">⚙️</span>설정</button>';
}
function markTab(id) {
  fixTabbar();
  ["home", "direct", "lang", "open", "settings"].forEach(function (t) {
    var b = document.getElementById("tk-tab-" + t);
    if (b) b.classList.toggle("on", t === id);
  });
}


/* ══════════════ 동시통역톡 (통역톡 안의 두 번째 칸) ══════════════
   서버 방인데 자동번역이 켜진 채로 태어난다.
   각자 자기 폰에서 자기 언어만 고르면 서로 자기 말로 쓰면 된다. */
function lseg(){
  var v = LS("pt2_lseg");
  return (v === "multi" || v === "trx") ? v : "one";
}
function liveRooms(){ return LSJ("pt2_live_rooms", []); }
function liveAdd(sid){
  var a = liveRooms();
  if (a.indexOf(sid) < 0) { a.push(sid); LSS("pt2_live_rooms", JSON.stringify(a)); }
}
function isLive(sid){ return liveRooms().indexOf(String(sid)) >= 0; }
function liveForget(sid){
  sid = String(sid);
  LSS("pt2_live_rooms", JSON.stringify(liveRooms().filter(function (x) { return x !== sid; })));
  var m = liveMeta(); delete m[sid]; LSS("pt2_live_meta", JSON.stringify(m));
  aliasSet(sid, ""); setMuted(sid, false);
  try { localStorage.removeItem("pt2_tr_" + sid); } catch (e) {}
  var c = svRooms().filter(function (r) { return r.id !== sid; });
  saveSvRooms(c);
}

/* 방을 만들자마자 목록에 보이게 하려고 이 기기에도 한 벌 적어둔다.
   서버 목록이 도착하기 전까지의 빈 화면을 없앤다. */
function liveMeta(){ return LSJ("pt2_live_meta", {}); }
function liveMetaSet(sid, o){
  var m = liveMeta(); m[String(sid)] = o; LSS("pt2_live_meta", JSON.stringify(m));
}
function liveKind(sid){ var m = liveMeta()[String(sid)]; return (m && m.kind) || "one"; }

function aliasGet(sid){ return LSJ("pt2_alias", {})[String(sid)] || ""; }
function aliasSet(sid, v){
  var o = LSJ("pt2_alias", {});
  if (v) o[String(sid)] = v; else delete o[String(sid)];
  LSS("pt2_alias", JSON.stringify(o));
}
function roomLabel(sid, fallback){ return aliasGet(sid) || fallback || "통역방"; }

function segBarHtml(cur){
  return '<div class="pt2-seg pt2-seg3">' +
    '<button class="' + (cur === "one" ? "on" : "") + '" data-pt2="lseg" data-v="one">💬 1:1<br>동시통역</button>' +
    '<button class="' + (cur === "multi" ? "on" : "") + '" data-pt2="lseg" data-v="multi">👥 다중<br>동시통역</button>' +
    '<button class="' + (cur === "trx" ? "on" : "") + '" data-pt2="lseg" data-v="trx">🔄 마주보기<br>통역</button>' +
  "</div>";
}

/* 서버에서 받은 목록과 이 기기 기록을 합친다 */
function liveList(kind){
  var ids = liveRooms(), meta = liveMeta(), byId = {};
  svRooms().forEach(function (r) { if (ids.indexOf(r.id) >= 0) byId[r.id] = r; });
  ids.forEach(function (id) {
    var m = meta[id] || {};
    if (!byId[id]) byId[id] = { id: id, name: m.name || "통역방", code: m.code || "", members: 1, ts: m.ts || 0 };
  });
  var out = [];
  Object.keys(byId).forEach(function (id) {
    if (liveKind(id) !== kind) return;
    out.push(byId[id]);
  });
  out.sort(function (a, b) { return (b.last_ts || b.ts || 0) - (a.last_ts || a.ts || 0); });
  return out;
}

function renderLive(kind){
  var mine = liveList(kind);
  var rows = mine.map(function (r) {
    var last = r.last_body ? ((r.last_nick ? r.last_nick + ": " : "") + r.last_body) : "아직 대화가 없어요";
    var t = ""; try { t = r.last_ts ? relTime(r.last_ts) : ""; } catch (e) {}
    return '<div class="pt2-lrow">' +
      '<div class="tk-room" data-action="talk-open" data-id="' + esc(PFX + r.id) + '">' +
      '<div class="tk-av trx-av">' + (kind === "multi" ? "👥" : "💬") + "</div>" +
      '<div class="tk-rmid"><div class="tk-rname">' + esc(roomLabel(r.id, r.name)) +
        '<span class="tk-cnt">👥 ' + (r.members || 1) + "</span>" +
        (r.code ? '<span class="trx-pair">' + esc(r.code) + "</span>" : "") +
        (muted(r.id) ? '<span class="tk-lock">🔕</span>' : "") + "</div>" +
        '<div class="tk-rlast">' + esc(last) + "</div></div>" +
      '<div class="tk-rmeta"><span class="tk-rtime">' + esc(t) + "</span>" +
        (!muted(r.id) && svUnread(r) ? '<span class="pt2-dot"></span>' : "") + "</div></div>" +
      '<button class="pt2-x" data-pt2="live-del" data-id="' + esc(r.id) + '" data-k="' + kind + '">\u2715</button></div>';
  }).join("");

  var head = ""; try { head = tkHeader("통역톡", kind === "multi" ? "👥 다중" : "💬 1:1"); } catch (e) {}
  document.querySelector("#view").innerHTML = head + segBarHtml(kind) +
    '<div class="trx-lead">서로 <b>떨어져 있을 때</b> 쓰는 통역이에요. 각자 자기 폰에서 <b>자기 말로만</b> 쓰면, 상대 화면에는 그 사람 언어로 번역돼 보입니다.' +
    (kind === "multi" ? "<br>여러 명이 각각 다른 언어를 골라도 됩니다." : "") + "</div>" +
    '<div class="tk-field"><label>내 언어</label><select class="pt2-langsel" data-pt2-lang="1">' + trxOpts(myLang()) + "</select></div>" +
    '<div class="tk-tools" style="margin-top:12px">' +
      '<button class="tk-tool primary" data-pt2="live-new" data-m="' + kind + '">＋ ' + (kind === "multi" ? "다중 통역방" : "1:1 통역방") + " 만들기</button>" +
      '<button class="tk-tool" data-pt2="join-code"># 코드로 입장</button>' +
    "</div>" +
    (mine.length ? '<div class="tk-tools" style="margin-top:-6px">' +
      '<button class="tk-tool" data-pt2="live-clear" data-k="' + kind + '">🧹 이 목록 비우기 (' + mine.length + '개)</button>' +
    "</div>" : "") +
    '<div class="pt2-sub" style="text-align:center;margin:10px 0 0">PT2 v' + PT2_VER + "</div>" +
    (rows ? '<div class="tk-list">' + rows + "</div>"
          : '<div class="tk-empty"><div class="ee">' + (kind === "multi" ? "👥" : "💬") + "</div>아직 통역방이 없어요.<br>＋ 를 누르면 바로 만들어집니다.</div>");
  markTab("lang");
}

/* 만들면 목록에 바로 쌓인다. 초대는 나중에 코드만 알려주면 된다 */
function liveNew(kind){
  if (!on()) { say("설정에서 서버 연결을 먼저 켜주세요"); return; }
  var multi = (kind === "multi");
  var def = multi ? "가족 통역방" : "1:1 통역방";
  var nm = prompt("통역방 이름을 정해주세요\n(초대받은 사람에게도 이 이름으로 보입니다)", def);
  if (nm === null) return;
  nm = (nm || "").trim() || def;
  say("통역방을 만드는 중…");
  api("/talk/room/create", { body: {
    name: nm, intro: "각자 자기 말로 쓰면 상대 언어로 번역됩니다",
    type: "general", uid: myUid(), nick: myNick(), is_private: 1, emoji: multi ? "👥" : "💬"
  }}).then(function (d) {
    if (!d.ok) { say(d.error || "방을 만들지 못했어요"); return; }
    saveToken(d.id, d.token);
    liveAdd(d.id);
    liveMetaSet(d.id, { kind: multi ? "multi" : "one", name: nm, code: d.code || "", ts: Date.now() });
    trSetOn(PFX + d.id, true);            /* 자동번역을 켠 채로 시작 */
    say("‘" + nm + "’ 방을 만들었어요");
    renderLive(multi ? "multi" : "one");   /* 방으로 들어가지 않고 목록에 남는다 */
    refreshRooms(function () {
      if (location.hash.indexOf("#/talk/trans") === 0 && lseg() !== "trx") renderLive(lseg());
    });
  });
}

/* ══════════════ 알림 목록 ══════════════
   index5 원본은 항목에 data-action 을 붙이지 않아 눌러도 아무 일이 없고,
   로컬 방만 훑어서 서버 방 알림은 아예 나오지 않는다. 둘 다 고친다. */
function renderAlarm() {
  var items = [], up = upMap();
  try {
    talkRooms().forEach(function (r) {
      if (r.noti === false) return;
      if (up[r.id]) return;                       /* 서버로 옮긴 방은 서버 쪽으로 나온다 */
      var m = talkMsgs(r.id);
      if (!m.length) return;
      var last = m[m.length - 1];
      if (last.who !== "them" && last.who !== "sys") return;
      items.push({
        ic: r.type === "dm" ? (r.emoji || "💬") : ((r.mode === "group") ? "👥" : "💬"),
        t: r.name,
        b: last.who === "sys" ? last.text : ((last.name ? last.name + ": " : "") + last.text),
        ts: last.ts, id: r.id, local: true
      });
    });
  } catch (e) {}

  svRooms().forEach(function (r) {
    if (!r.last_body || muted(r.id)) return;
    items.push({
      ic: r.emoji || "🍇", t: r.name,
      b: (r.last_nick ? r.last_nick + ": " : "") + r.last_body,
      ts: r.last_ts || 0, id: PFX + r.id, local: false, unread: svUnread(r)
    });
  });

  items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

  var body = items.length
    ? '<div class="tk-alarm pt2-alarm">' + items.map(function (it) {
        var t = "";
        try { t = it.ts ? relTime(it.ts) : ""; } catch (e) {}
        return '<div class="tk-al" data-action="talk-open" data-id="' + esc(it.id) + '">' +
          '<div class="tk-ai">' + esc(it.ic) + "</div>" +
          '<div class="tk-at"><div class="tk-att">' + esc(it.t) +
            (it.local ? ' <span class="pt2-badge">📱 이 기기</span>' : "") + "</div>" +
          '<div class="tk-ab">' + esc(it.b) + "</div></div>" +
          '<div class="tk-atime">' + esc(t) +
            (it.unread ? ' <span class="pt2-dot"></span>' : "") + "</div></div>";
      }).join("") + "</div>"
    : '<div class="tk-empty"><div class="ee">🔔</div>새로운 알림이 없어요</div>';

  var head = "";
  try { head = tkHeader("알림", "포도톡"); } catch (e) {}
  document.querySelector("#view").innerHTML = head + body;
  markTab("");
}

/* ══════════════ STEP 5 · 과제 · 방 설정 ══════════════ */
window.renderTalk = function (sub, arg) {
  if (sub === "trans") {
    if (arg) return trxRoom(arg);
    var k = lseg();
    if (k !== "trx") {
      renderLive(k);
      if (on()) refreshRooms(function () {
        if (location.hash.indexOf("#/talk/trans") === 0 && lseg() !== "trx") renderLive(lseg());
      });
      return;
    }
    return trxList();
  }
  if (sub === "transset" && arg) return trxSettings(arg);
  if (sub === "lang") { location.replace("#/talk/trans"); return; }
  if (STEP >= 5 && on() && sub === "tasks" && arg) return renderTasks(arg);
  if (STEP >= 2 && on() && sub === "alarm") {
    renderAlarm();
    /* 서버 목록을 새로 받아 한 번만 다시 그린다. renderAlarm 안에서 부르면 무한 반복이 된다 */
    refreshRooms(function () {
      if (location.hash.indexOf("#/talk/alarm") === 0) renderAlarm();
    });
    return;
  }
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
  markTab("open");
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
    "<h3>" + esc(roomLabel(bare(id), r.name)) + "</h3>" +
    '<div class="sd">초대 코드 <b>' + esc(r.code || "-") + "</b> · " + (r.members || 1) + "명 참여 중</div>" +
    '<button class="cta grape" data-pt2="copy-code">초대 코드 복사</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="rename" data-id="' + esc(id) + '">✏️ 방 이름 바꾸기</button>' +
    '<div class="tk-toggle" style="margin-top:10px">🔔 이 방 알림<span class="tk-sw' + (muted(bare(id)) ? "" : " on") + '" data-pt2="noti-toggle" data-id="' + esc(id) + '"></span></div>' +
    '<div class="tk-toggle" style="margin-top:10px">🌐 자동번역<span class="tk-sw' + (trOn(id) ? " on" : "") + '" data-pt2="tr-toggle" data-id="' + esc(id) + '"></span></div>' +
    '<div class="pt2-sub" style="margin-top:6px">켜면 <b>남이 쓴 글</b>이 내 언어로 번역돼 보여요. 원문은 아래에 작게 남습니다. 상대도 각자 자기 언어를 고르면 서로 그냥 자기 말로 쓰면 됩니다.</div>' +
    '<div class="tk-field" style="margin-top:8px"><label>내 언어</label>' +
      '<select class="pt2-langsel" data-pt2-lang="1">' + trxOpts(myLang()) + '</select></div>' +
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
/* 서비스워커 등록.
   index5 는 pdPushSubscribe() 안에서만 sw.js 를 등록하는데, 아래에서 그 함수를
   무력화하기 때문에 여기서 직접 등록해야 한다. 이게 없으면
   serviceWorker.ready 가 영원히 멈춰 토글을 눌러도 아무 반응이 없다. */
function swReady() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return Promise.reject(new Error("이 브라우저는 웹 알림을 지원하지 않아요"));
  }
  return navigator.serviceWorker.register("/sw.js")
    .catch(function () { return null; })              /* 이미 등록돼 있으면 그대로 진행 */
    .then(function () {
      return Promise.race([
        navigator.serviceWorker.ready,
        new Promise(function (_r, rej) {
          setTimeout(function () { rej(new Error("서비스워커가 준비되지 않아요. sw.js 가 있는지 확인하세요")); }, 8000);
        })
      ]);
    });
}
if (STEP >= 6 && "serviceWorker" in navigator) {
  try { navigator.serviceWorker.register("/sw.js").catch(function () {}); } catch (e) {}
}

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
  /* ready 는 등록이 없으면 영영 멈춘다. 상태 확인용으로는 getRegistration 을 쓴다. */
  return navigator.serviceWorker.getRegistration()
    .then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; })
    .catch(function () { return null; });
}
function paintPushSwitch() {
  getSub().then(function (s) {
    var sw = document.getElementById("pt2PushSw");
    if (sw) sw.className = "tk-sw" + (s ? " on" : "");
  });
}
function pushOn() {
  say("알림을 준비하는 중…");
  Promise.resolve()
    .then(function () { return Notification.requestPermission(); })
    .then(function (p) {
      if (p !== "granted") throw new Error("기기 설정에서 알림을 허용해 주세요");
      return api("/push/key");
    })
    .then(function (k) {
      if (!k || !k.key) throw new Error("서버에 알림 키가 없어요. 워커에 VAPID_PUBLIC 을 넣어주세요");
      return swReady().then(function (reg) {
        return reg.pushManager.getSubscription().then(function (old) {
          /* 예전에 포도다 키로 만든 구독이 남아 있으면 반드시 먼저 해지해야
             다른 키로 subscribe 가 InvalidStateError 없이 성공한다 */
          if (old && !sameKey(old, k.key)) return old.unsubscribe().then(function () { return null; });
          return old;
        }).then(function (cur) {
          if (cur) return cur;
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(k.key) });
        });
      });
    })
    .then(function (sub) {
      return api("/push/subscribe", { body: { uid: myUid(), sub: sub.toJSON ? sub.toJSON() : sub } });
    })
    .then(function (r) {
      if (r && r.ok) { say("알림을 켰어요 🔔"); paintPushSwitch(); }
      else throw new Error((r && r.error) || "서버에 등록하지 못했어요");
    })
    .catch(function (e) {
      say(e && e.message ? e.message : "알림을 켜지 못했어요");
      paintPushSwitch();
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


/* ══════════════════════════════════════════════════════════════
   🌍 통역톡 — 방 자체가 통역기
     · 한 방에서 두 사람이 각자 자기 말로 쓴다
     · 상대에게는 그 사람 언어로 번역돼 보인다
     · 🔄 마주보기를 켜면 상대 말풍선이 180도 돌아 맞은편에서 읽힌다
     · 🎙️ 를 누르면 말한 대로 옮겨 보내고, 상대 말은 폰이 읽어준다
   번역: 포도랑 워커(DeepL·GPT) → Google 무료 → MyMemory → 내 AI 키
   ══════════════════════════════════════════════════════════════ */
var TRX_API = "https://podolang.hasin7jk.workers.dev";
var TRXL = [
  ["KO","한국어","🇰🇷","ko","ko-KR"], ["EN","영어","🇺🇸","en","en-US"],
  ["VI","베트남어","🇻🇳","vi","vi-VN"], ["ZH","중국어","🇨🇳","zh-CN","zh-CN"],
  ["TH","태국어","🇹🇭","th","th-TH"], ["JA","일본어","🇯🇵","ja","ja-JP"],
  ["ID","인도네시아어","🇮🇩","id","id-ID"], ["UZ","우즈베크어","🇺🇿","uz","uz-UZ"],
  ["NE","네팔어","🇳🇵","ne","ne-NP"], ["MY","미얀마어","🇲🇲","my","my-MM"],
  ["KM","캄보디아어","🇰🇭","km","km-KH"], ["MN","몽골어","🇲🇳","mn","mn-MN"],
  ["TL","필리핀어","🇵🇭","tl","fil-PH"], ["RU","러시아어","🇷🇺","ru","ru-RU"],
  ["ES","스페인어","🇪🇸","es","es-ES"], ["FR","프랑스어","🇫🇷","fr","fr-FR"],
  ["DE","독일어","🇩🇪","de","de-DE"], ["PT","포르투갈어","🇧🇷","pt","pt-BR"],
  ["IT","이탈리아어","🇮🇹","it","it-IT"], ["AR","아랍어","🇸🇦","ar","ar-SA"],
  ["HI","힌디어","🇮🇳","hi","hi-IN"], ["NL","네덜란드어","🇳🇱","nl","nl-NL"],
  ["TR","터키어","🇹🇷","tr","tr-TR"], ["UK","우크라이나어","🇺🇦","uk","uk-UA"]
];
function trxL(c){ for(var i=0;i<TRXL.length;i++){ if(TRXL[i][0]===c) return TRXL[i]; } return TRXL[0]; }
function trxName(c){ return trxL(c)[1]; }
function trxFlag(c){ return trxL(c)[2]; }
function trxG(c){ return trxL(c)[3]; }
function trxBcp(c){ return trxL(c)[4]; }
function trxOpts(sel){
  var h="";
  for(var i=0;i<TRXL.length;i++){ var x=TRXL[i];
    h += '<option value="'+x[0]+'"'+(x[0]===sel?" selected":"")+'>'+x[2]+" "+x[1]+"</option>"; }
  return h;
}

/* 저장은 원본 localStorage 로. 나라 접두어·정화를 타면 대화가 사라지거나 글자가 깎인다 */
function trxRooms(){ return LSJ("pt2_trx_rooms", []); }
function trxSaveRooms(v){ LSS("pt2_trx_rooms", JSON.stringify(v || [])); }
function trxFind(id){ var r=trxRooms(); for(var i=0;i<r.length;i++){ if(r[i].id===id) return r[i]; } return null; }
function trxPut(room){
  var rs=trxRooms(), hit=false;
  for(var i=0;i<rs.length;i++){ if(rs[i].id===room.id){ rs[i]=room; hit=true; } }
  if(!hit) rs.unshift(room);
  trxSaveRooms(rs);
}
function trxMsgs(id){ return LSJ("pt2_trx_m_"+id, []); }
function trxSaveMsgs(id, v){ LSS("pt2_trx_m_"+id, JSON.stringify((v||[]).slice(-300))); }
function trxFlipOn(){ return LS("pt2_trx_flip") === "1"; }
function trxEngine(){ return LS("pt2_trx_engine") === "free" ? "free" : "podo"; }

/* ── 번역 엔진 ── */
function trxTr(text, fromC, toC, ok){
  var f=trxG(fromC), t=trxG(toC);
  if(!text || fromC===toC){ ok(text, "원문"); return; }
  var free=function(){
    trxGoogle(text,f,t,function(o){ ok(o,"Google"); }, function(){
      trxMyMemory(text,f,t,function(o){ ok(o,"MyMemory"); }, function(){
        trxAI(text,fromC,toC,function(o){ ok(o, o?"AI":""); });
      });
    });
  };
  if(trxEngine()==="free"){ free(); return; }
  trxPodolang(text, fromC, toC, function(o,e){ ok(o,e); }, free);
}
function trxPodolang(text, fromC, toC, ok, fail){
  try{
    var to=setTimeout(function(){ to=null; fail(); }, 12000);
    fetch(TRX_API+"/api/translate", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ text:text, sourceLang:fromC, targetLang:toC }) })
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(d){
        if(to===null) return; clearTimeout(to);
        var out = d && d.translated ? String(d.translated).trim() : "";
        if(!out){ fail(); return; }
        ok(out, "포도랑·"+(d.engine||"GPT"));
      })["catch"](function(){ if(to===null) return; clearTimeout(to); fail(); });
  }catch(e){ fail(); }
}
function trxGoogle(text, f, t, ok, fail){
  try{
    var u="https://translate.googleapis.com/translate_a/single?client=gtx&sl="+encodeURIComponent(f)+
          "&tl="+encodeURIComponent(t)+"&dt=t&q="+encodeURIComponent(text);
    var to=setTimeout(function(){ to=null; fail(); }, 8000);
    fetch(u).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(d){
      if(to===null) return; clearTimeout(to);
      var seg=d&&d[0]; if(!seg||!seg.length){ fail(); return; }
      var out=""; for(var i=0;i<seg.length;i++) out+=(seg[i][0]||"");
      out=out.trim(); if(!out){ fail(); return; }
      ok(out);
    })["catch"](function(){ if(to===null) return; clearTimeout(to); fail(); });
  }catch(e){ fail(); }
}
function trxMyMemory(text, f, t, ok, fail){
  try{
    var u="https://api.mymemory.translated.net/get?q="+encodeURIComponent(text)+
          "&langpair="+encodeURIComponent(f+"|"+t);
    var to=setTimeout(function(){ to=null; fail(); }, 8000);
    fetch(u).then(function(r){ return r.json(); }).then(function(d){
      if(to===null) return; clearTimeout(to);
      var x=d&&d.responseData&&d.responseData.translatedText;
      if(x && !/MYMEMORY WARNING|INVALID|NO QUERY/i.test(x)) ok(String(x).trim()); else fail();
    })["catch"](function(){ if(to===null) return; clearTimeout(to); fail(); });
  }catch(e){ fail(); }
}
function trxAI(text, fromC, toC, done){
  var has=false; try{ has=!!getKey(); }catch(e){}
  if(!has){ done(""); return; }
  var sys="You are a live interpreter for a small business. Translate the message from "+
    trxName(fromC)+" into "+trxName(toC)+
    ". Keep it natural spoken workplace language. Keep numbers, times, prices, product codes and proper names exactly as written. "+
    "Return ONLY the translated sentence with no quotes and no explanation.";
  try{
    aiComplete({ system:sys, blocks:[{type:"text", text:text}], max_tokens:600, temperature:0 })
      .then(function(t){ done(String(t||"").trim()); })["catch"](function(){ done(""); });
  }catch(e){ done(""); }
}

/* ── 폰이 읽어주기 ── */
function trxSay(text, langC){
  if(!text || !window.speechSynthesis) return;
  try{
    window.speechSynthesis.cancel();
    var u=new SpeechSynthesisUtterance(text);
    u.lang=trxBcp(langC); u.rate=1.0;
    window.speechSynthesis.speak(u);
  }catch(e){}
}

/* ── 마이크 ① 폰 받아쓰기 ── */
var trxRec=null;
function trxMicSupported(){ return !!(window.SpeechRecognition||window.webkitSpeechRecognition); }
function trxMicStop(){
  if(trxRec){ try{ trxRec.stop(); }catch(e){} }
  trxRec=null;
  var b=document.getElementById("trxMic"); if(b) b.classList.remove("rec");
  var h=document.getElementById("trxHint"); if(h) h.textContent="";
}
function trxMicStart(id){
  var r=trxFind(id); if(!r) return;
  if(trxMR){ trxSrvStop(); return; }
  if(trxRec){ trxMicStop(); return; }
  if(!trxMicSupported()){ trxSrvStart(id); return; }
  var side=r.turn||"a";
  var lang=(side==="a")?r.aLang:r.bLang;
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  try{
    trxRec=new SR();
    trxRec.lang=trxBcp(lang);
    trxRec.interimResults=true;
    trxRec.continuous=false;
    var got="";
    trxRec.onresult=function(ev){
      var interim="";
      for(var i=ev.resultIndex;i<ev.results.length;i++){
        var t=ev.results[i][0].transcript;
        if(ev.results[i].isFinal) got+=t; else interim+=t;
      }
      var inp=document.getElementById("trxInput"); if(inp) inp.value=(got+interim).trim();
    };
    trxRec.onerror=function(){ trxMicStop(); };
    trxRec.onend=function(){
      var inp=document.getElementById("trxInput");
      var v=inp?(inp.value||"").trim():"";
      trxMicStop();
      if(v) trxSend(id);
    };
    trxRec.start();
    var b=document.getElementById("trxMic"); if(b) b.classList.add("rec");
    var h=document.getElementById("trxHint");
    if(h) h.textContent="🎙️ "+trxFlag(lang)+" "+trxName(lang)+"로 듣는 중… 말이 끝나면 자동으로 보냅니다";
  }catch(e){ trxMicStop(); say("마이크를 시작할 수 없어요"); }
}

/* ── 마이크 ② 포도랑 서버 (아이폰·사파리처럼 받아쓰기가 없는 기기) ── */
var trxMR=null, trxChunks=[];
function trxSrvStop(){
  try{ if(trxMR && trxMR.state!=="inactive") trxMR.stop(); }catch(e){}
  var b=document.getElementById("trxMic"); if(b) b.classList.remove("rec");
}
function trxSrvStart(id){
  var r=trxFind(id); if(!r) return;
  if(trxMR){ trxSrvStop(); return; }
  if(!navigator.mediaDevices || !window.MediaRecorder){ say("이 브라우저는 녹음을 지원하지 않아요"); return; }
  var side=r.turn||"a";
  var from=(side==="a")?r.aLang:r.bLang;
  var to  =(side==="a")?r.bLang:r.aLang;
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(st){
    trxChunks=[];
    trxMR=new MediaRecorder(st);
    trxMR.ondataavailable=function(e){ if(e.data && e.data.size) trxChunks.push(e.data); };
    trxMR.onstop=function(){
      try{ st.getTracks().forEach(function(t){ t.stop(); }); }catch(e){}
      var blob=new Blob(trxChunks,{type:"audio/webm"});
      trxMR=null;
      var b=document.getElementById("trxMic"); if(b) b.classList.remove("rec");
      if(blob.size<1500){ var h0=document.getElementById("trxHint"); if(h0) h0.textContent=""; return; }
      trxSrvSend(id, blob, side, from, to);
    };
    trxMR.start();
    var b=document.getElementById("trxMic"); if(b) b.classList.add("rec");
    var h=document.getElementById("trxHint");
    if(h) h.textContent="🎙️ "+trxFlag(from)+" 녹음 중… 다 말했으면 🎙️ 를 다시 누르세요";
  })["catch"](function(){ say("마이크 권한을 확인해주세요"); });
}
function trxSrvSend(id, blob, side, from, to){
  var h=document.getElementById("trxHint"); if(h) h.textContent="🍇 포도랑이 알아듣는 중…";
  var msgs=trxMsgs(id);
  msgs.push({ side:side, src:"(음성)", dst:"", engine:"", pending:true, ts:Date.now() });
  trxSaveMsgs(id, msgs);
  var at=msgs.length-1;
  trxRoom(id);
  var fd=new FormData();
  fd.append("audio", blob, "voice.webm");
  fd.append("sourceLang", from);
  fd.append("targetLang", to);
  fetch(TRX_API+"/api/podolang", { method:"POST", body:fd })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d && d.error) throw new Error(d.error);
      var m2=trxMsgs(id);
      if(m2[at]){
        m2[at].src=d.original||"(음성)";
        m2[at].dst=d.translated||"";
        m2[at].engine="포도랑·"+(d.engine||"GPT");
        m2[at].pending=false;
        trxSaveMsgs(id,m2);
      }
      if(location.hash.indexOf("#/talk/trans/"+id)===0) trxRoom(id);
      if(d.audioBase64){ try{ new Audio("data:audio/mpeg;base64,"+d.audioBase64).play(); }catch(e){} }
      else if(d.translated){ trxSay(d.translated, to); }
    })["catch"](function(e){
      var m3=trxMsgs(id);
      if(m3[at]){ m3.splice(at,1); trxSaveMsgs(id,m3); }
      if(location.hash.indexOf("#/talk/trans/"+id)===0) trxRoom(id);
      say((e&&e.message)||"음성을 알아듣지 못했어요");
    });
}

/* ── 방 목록 ── */
function trxList(){
  var rs=trxRooms();
  if(!rs.length){
    trxPut({ id:"trx"+Date.now(), name:"우리 가게 통역방", aName:"사장님", bName:"직원",
             aLang:"KO", bLang:"VI", turn:"a", ts:Date.now() });
    rs=trxRooms();
  }
  rs.sort(function(a,b){
    var am=trxMsgs(a.id), bm=trxMsgs(b.id);
    return ((bm.length?bm[bm.length-1].ts:b.ts)-(am.length?am[am.length-1].ts:a.ts));
  });
  var rows=rs.map(function(r){
    var m=trxMsgs(r.id), last=m.length?m[m.length-1]:null;
    var lastText=last?(last.src||""):"두 사람의 언어를 고르고 바로 시작하세요";
    var t=""; try{ t=last?relTime(last.ts):""; }catch(e){}
    return '<div class="tk-room" data-action="trx-open" data-id="'+esc(r.id)+'">'+
      '<div class="tk-av trx-av">🌍</div>'+
      '<div class="tk-rmid"><div class="tk-rname">'+esc(r.name)+
        '<span class="trx-pair">'+trxFlag(r.aLang)+"⇄"+trxFlag(r.bLang)+"</span></div>"+
        '<div class="tk-rlast">'+esc(lastText.length>34?lastText.slice(0,34)+"…":lastText)+"</div></div>"+
      '<div class="tk-rmeta"><span class="tk-rtime">'+esc(t)+"</span></div></div>";
  }).join("");
  var head=""; try{ head=tkHeader("통역톡","🔄 마주보기"); }catch(e){}
  document.querySelector("#view").innerHTML = head + segBarHtml("trx") +
    '<div class="trx-lead">한 방에서 <b>각자 자기 말로</b> 씁니다. 상대에게는 <b>그 사람 언어로</b> 번역돼 보여요.<br>'+
    '마이크를 누르면 말한 대로 옮겨 보내고, 상대 말은 폰이 읽어줍니다.</div>'+
    '<div class="tk-tools"><button class="tk-tool primary" data-action="trx-new">＋ 통역방 만들기</button></div>'+
    '<div class="tk-list">'+rows+"</div>";
  markTab("lang");
}
function trxNew(){
  var id="trx"+Date.now();
  trxPut({ id:id, name:"새 통역방", aName:"사장님", bName:"직원",
           aLang:"KO", bLang:"VI", turn:"a", ts:Date.now() });
  location.hash="#/talk/trans/"+id;
}

/* ── 방 화면 ── */
function trxRoom(id){
  var r=trxFind(id);
  if(!r){ location.hash="#/talk/trans"; return; }
  var flip=trxFlipOn();
  var msgs=trxMsgs(id);
  var rows=msgs.map(function(m,i){
    var mine=(m.side==="a");
    var who = mine ? r.aName : r.bName;
    var srcL= mine ? r.aLang : r.bLang;
    var dstL= mine ? r.bLang : r.aLang;
    var big = m.dst || m.src;
    var pend= m.pending ? '<span class="trx-dots">●●●</span>' : "";
    /* 마주보기: 상대(오른쪽 사람)가 읽어야 하는 말풍선을 뒤집는다.
       왼쪽 사람이 한 말 → 번역문이 상대 언어이므로 이쪽을 돌려야 맞은편에서 읽힌다. */
    var cls = "trx-row "+(mine?"a":"b")+((flip&&mine)?" flip":"");
    return '<div class="'+cls+'"><div class="trx-b">'+
      '<div class="trx-who">'+esc(who)+' <span class="trx-lg">'+trxFlag(srcL)+"</span></div>"+
      '<div class="trx-src">'+esc(m.src)+"</div>"+
      '<div class="trx-dst">'+trxFlag(dstL)+" "+esc(big)+pend+"</div>"+
      '<div class="trx-foot"><span>'+trxName(srcL)+" → "+trxName(dstL)+(m.engine?" · "+esc(m.engine):"")+"</span>"+
        '<button class="trx-mini" data-action="trx-say" data-id="'+esc(id)+'" data-i="'+i+'">🔊 듣기</button>'+
        '<button class="trx-mini" data-action="trx-copy" data-id="'+esc(id)+'" data-i="'+i+'">복사</button></div>'+
      "</div></div>";
  }).join("");
  if(!rows) rows='<div class="trx-empty"><div class="trx-ee">🌍</div>아래에서 <b>말하는 사람</b>을 고르고<br>자기 말로 쓰거나 🎙️ 를 누르세요</div>';
  var turn=r.turn||"a";
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead pt2-fixhead"><span class="tk-back" data-pt2="lang">‹</span>'+
      '<div class="tk-savatar">🌍</div>'+
      '<div class="tk-rh-mid"><div class="tk-hi">'+esc(r.name)+"</div>"+
        '<div class="tk-hs">'+trxFlag(r.aLang)+" "+trxName(r.aLang)+" ⇄ "+trxFlag(r.bLang)+" "+trxName(r.bLang)+"</div></div>"+
      '<div class="tk-racts">'+
        '<button class="tk-ract'+(flip?" on":"")+'" data-action="trx-flip" data-id="'+esc(id)+'" title="마주보기">🔄</button>'+
        '<button class="tk-ract" data-action="trx-set" data-id="'+esc(id)+'">⚙️</button>'+
      "</div></div>"+
    '<div class="trx-wrap" id="trxWrap">'+
      '<div class="trx-langbar">'+
        '<div class="trx-lsel a"><label>'+esc(r.aName)+"</label>"+
          '<select id="trxA" data-action="trx-lang" data-id="'+esc(id)+'" data-w="a">'+trxOpts(r.aLang)+"</select></div>"+
        '<button class="trx-swap" data-action="trx-swap" data-id="'+esc(id)+'">⇄</button>'+
        '<div class="trx-lsel b"><label>'+esc(r.bName)+"</label>"+
          '<select id="trxB" data-action="trx-lang" data-id="'+esc(id)+'" data-w="b">'+trxOpts(r.bLang)+"</select></div>"+
      "</div>"+
      '<div class="trx-engbar">'+
        '<button class="trx-eng'+(trxEngine()==="podo"?" on":"")+'" data-action="trx-eng" data-v="podo" data-id="'+esc(id)+'">🍇 포도랑 정밀번역</button>'+
        '<button class="trx-eng'+(trxEngine()==="free"?" on":"")+'" data-action="trx-eng" data-v="free" data-id="'+esc(id)+'">⚡ 무료 번역</button>'+
      "</div>"+
      (flip ? '<div class="trx-flipnote">🔄 마주보기 · '+esc(r.bName)+'님이 읽을 글은 뒤집혀 있어요. 폰을 두 사람 사이에 놓으세요</div>' : "")+
      '<div class="trx-msgs" id="trxMsgs">'+rows+"</div>"+
    "</div>"+
    '<div class="trx-bar">'+
      '<div class="trx-turn">'+
        '<button class="trx-t'+(turn==="a"?" on a":"")+'" data-action="trx-turn" data-id="'+esc(id)+'" data-w="a">'+trxFlag(r.aLang)+" "+esc(r.aName)+"</button>"+
        '<button class="trx-t'+(turn==="b"?" on b":"")+'" data-action="trx-turn" data-id="'+esc(id)+'" data-w="b">'+trxFlag(r.bLang)+" "+esc(r.bName)+"</button>"+
      "</div>"+
      '<div class="trx-hint" id="trxHint"></div>'+
      '<div class="trx-inrow">'+
        '<input id="trxInput" autocomplete="off" placeholder="'+esc(turn==="a"?trxName(r.aLang):trxName(r.bLang))+'로 입력하세요">'+
        '<button class="trx-mic" id="trxMic" data-action="trx-mic" data-id="'+esc(id)+'">🎙️</button>'+
        '<button class="trx-send" data-action="trx-send" data-id="'+esc(id)+'">➤</button>'+
      "</div></div>";
  markTab("lang");
  trxFit();
  requestAnimationFrame(trxFit);
  trxBottom();
  var inp=document.getElementById("trxInput");
  if(inp) inp.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); trxSend(id); } });
}
/* 위(헤더)와 아래(입력바)를 실제로 재서 가운데 목록 높이를 맞춘다 */
function trxFit(){
  var h=document.querySelector(".pt2-fixhead");
  var w=document.getElementById("trxWrap");
  var bar=document.querySelector(".trx-bar");
  if(!h||!w) return;
  w.style.top=h.offsetHeight+"px";
  var vh=(window.visualViewport&&window.visualViewport.height)||window.innerHeight;
  if(bar){ var rc=bar.getBoundingClientRect(); w.style.bottom=Math.max(0,Math.round(vh-rc.top))+"px"; }
}
window.addEventListener("resize", function(){ if(location.hash.indexOf("#/talk/trans/")===0) trxFit(); });
try{ if(window.visualViewport) window.visualViewport.addEventListener("resize", function(){
  if(location.hash.indexOf("#/talk/trans/")===0) trxFit(); }); }catch(e){}
function trxBottom(){ try{ var b=document.getElementById("trxMsgs"); if(b) b.scrollTop=b.scrollHeight; }catch(e){} }

/* ── 보내기 ── */
function trxSend(id){
  var r=trxFind(id); if(!r) return;
  var inp=document.getElementById("trxInput"); if(!inp) return;
  var text=(inp.value||"").trim(); if(!text) return;
  var side=r.turn||"a";
  var from=(side==="a")?r.aLang:r.bLang;
  var to  =(side==="a")?r.bLang:r.aLang;
  var msgs=trxMsgs(id);
  msgs.push({ side:side, src:text, dst:"", engine:"", pending:true, ts:Date.now() });
  trxSaveMsgs(id, msgs);
  inp.value="";
  trxRoom(id);
  var at=msgs.length-1;
  trxTr(text, from, to, function(out, eng){
    var m2=trxMsgs(id);
    if(m2[at]){ m2[at].dst=out||text; m2[at].engine=eng||""; m2[at].pending=false; trxSaveMsgs(id,m2); }
    if(location.hash.indexOf("#/talk/trans/"+id)===0) trxRoom(id);
    if(out) trxSay(out, to);
  });
}

/* ── 방 설정 ── */
function trxSettings(id){
  var r=trxFind(id); if(!r) return;
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead"><span class="tk-back" data-action="trx-open" data-id="'+esc(id)+'">‹</span>'+
      '<div class="tk-rh-mid"><div class="tk-hi">통역방 설정</div><div class="tk-hs">'+esc(r.name)+"</div></div></div>"+
    '<div class="trx-set">'+
      "<label>방 이름</label><input id=\"trxSN\" value=\""+esc(r.name)+"\">"+
      "<label>왼쪽 사람 이름</label><input id=\"trxAN\" value=\""+esc(r.aName)+"\">"+
      "<label>오른쪽 사람 이름</label><input id=\"trxBN\" value=\""+esc(r.bName)+"\">"+
      '<button class="cta grape" data-action="trx-save" data-id="'+esc(id)+'">저장</button>'+
      '<button class="cta trx-ghost" data-action="trx-del" data-id="'+esc(id)+'">이 통역방 삭제</button>'+
    "</div>";
  markTab("lang");
}

/* ── 통역톡 클릭 ── */
document.addEventListener("click", function(e){
  var el=e.target && e.target.closest ? e.target.closest("[data-action]") : null;
  if(!el) return;
  var a=el.getAttribute("data-action");
  if(!a || a.indexOf("trx-")!==0) return;
  var id=el.getAttribute("data-id");
  if(a==="trx-new"){ trxNew(); return; }
  if(a==="trx-open"){ location.hash="#/talk/trans/"+id; return; }
  if(a==="trx-send"){ trxSend(id); return; }
  if(a==="trx-mic"){ trxMicStart(id); return; }
  if(a==="trx-eng"){
    var v=el.getAttribute("data-v");
    LSS("pt2_trx_engine", v==="free"?"free":"podo");
    trxRoom(id);
    say(v==="podo" ? "🍇 포도랑 정밀번역으로 바꿨어요" : "⚡ 무료 번역으로 바꿨어요");
    return;
  }
  if(a==="trx-set"){ location.hash="#/talk/transset/"+id; return; }
  if(a==="trx-flip"){
    var on2=!trxFlipOn();
    LSS("pt2_trx_flip", on2?"1":"0");
    trxRoom(id||(location.hash.split("/")[3]||""));
    say(on2 ? "🔄 마주보기 켰어요 · 폰을 두 사람 사이에 놓으세요" : "마주보기를 껐어요");
    return;
  }
  if(a==="trx-turn"){
    var r=trxFind(id); if(!r) return;
    r.turn=el.getAttribute("data-w"); trxPut(r); trxRoom(id);
    var i2=document.getElementById("trxInput"); if(i2){ try{ i2.focus(); }catch(e2){} }
    return;
  }
  if(a==="trx-swap"){
    var r2=trxFind(id); if(!r2) return;
    var t=r2.aLang; r2.aLang=r2.bLang; r2.bLang=t; trxPut(r2); trxRoom(id);
    say("두 언어를 서로 바꿨어요"); return;
  }
  if(a==="trx-say"){
    var r3=trxFind(id); if(!r3) return;
    var m=trxMsgs(id)[parseInt(el.getAttribute("data-i"),10)]; if(!m) return;
    trxSay(m.dst||m.src, m.side==="a"?r3.bLang:r3.aLang); return;
  }
  if(a==="trx-copy"){
    var m2=trxMsgs(id)[parseInt(el.getAttribute("data-i"),10)]; if(!m2) return;
    try{ copyText(m2.dst||m2.src); say("번역문을 복사했어요"); }catch(e3){}
    return;
  }
  if(a==="trx-save"){
    var r4=trxFind(id); if(!r4) return;
    var n=document.getElementById("trxSN"), an=document.getElementById("trxAN"), bn=document.getElementById("trxBN");
    r4.name=((n&&n.value)||"").trim()||r4.name;
    r4.aName=((an&&an.value)||"").trim()||r4.aName;
    r4.bName=((bn&&bn.value)||"").trim()||r4.bName;
    trxPut(r4); say("저장했어요"); location.hash="#/talk/trans/"+id; return;
  }
  if(a==="trx-del"){
    if(!confirm("이 통역방과 대화를 삭제할까요?")) return;
    trxSaveRooms(trxRooms().filter(function(x){ return x.id!==id; }));
    try{ localStorage.removeItem("pt2_trx_m_"+id); }catch(e4){}
    location.hash="#/talk/trans"; return;
  }
});
document.addEventListener("change", function (e) {
  var el = e.target;
  if (!el || !el.getAttribute || el.getAttribute("data-pt2-lang") !== "1") return;
  setMyLang(el.value);
  say("내 언어를 " + trxFlag(el.value) + " " + trxName(el.value) + " 로 정했어요");
  P.sig = ""; renderMsgs(P.list || [], false);
});
document.addEventListener("change", function(e){
  var el=e.target;
  if(!el || !el.getAttribute || el.getAttribute("data-action")!=="trx-lang") return;
  var id=el.getAttribute("data-id"), w=el.getAttribute("data-w");
  var r=trxFind(id); if(!r) return;
  if(w==="a") r.aLang=el.value; else r.bLang=el.value;
  trxPut(r); trxRoom(id);
  say(trxFlag(r.aLang)+" "+trxName(r.aLang)+" ⇄ "+trxFlag(r.bLang)+" "+trxName(r.bLang));
});
/* 화면을 떠나면 마이크를 확실히 끈다 */
window.addEventListener("hashchange", function(){
  if(location.hash.indexOf("#/talk/trans")!==0){ trxMicStop(); trxSrvStop(); }
});

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

  /* 탭 · 칸 나누기 */
  if (a === "seg") {
    LSS("pt2_seg", el.getAttribute("data-v") === "shop" ? "shop" : "open");
    renderOpen();
    if (on()) refreshRooms(function () {
      if (location.hash.indexOf("#/talk/open") === 0 || location.hash === "#/talk") renderOpen();
    });
    return;
  }
  if (a === "lang") { location.hash = "#/talk/trans"; return; }
  if (a === "lseg") {
    LSS("pt2_lseg", el.getAttribute("data-v"));
    if (location.hash === "#/talk/trans") { try { renderTalk("trans", null); } catch (_e) {} }
    else location.hash = "#/talk/trans";
    return;
  }
  if (a === "live-new") { liveNew(el.getAttribute("data-m")); return; }
  if (a === "live-clear") {
    var kc = el.getAttribute("data-k") || lseg();
    var all = liveList(kc);
    if (!all.length) return;
    if (!confirm("이 목록의 통역방 " + all.length + "개를 모두 지울까요?\n내가 만든 방은 서버에서도 삭제됩니다.")) return;
    say("정리하는 중…");
    var n = 0;
    var fin = function () { n++; if (n >= all.length) { renderLive(kc); say("목록을 비웠어요"); } };
    all.forEach(function (r) {
      var tk2 = tokenOf(r.id);
      var go = function () { liveForget(r.id); fin(); };
      if (tk2) api("/talk/room/delete", { body: { room_id: r.id }, token: tk2 }).then(go, go);
      else api("/talk/room/leave", { body: { room_id: r.id, uid: myUid() } }).then(go, go);
    });
    return;
  }
  if (a === "live-del") {
    var sid = el.getAttribute("data-id"), kk = el.getAttribute("data-k") || lseg();
    var mt = liveMeta()[sid] || {};
    if (!confirm("‘" + roomLabel(sid, mt.name) + "’ 을(를) 목록에서 지울까요?\n내가 만든 방이면 서버에서도 삭제됩니다.")) return;
    var tk = tokenOf(sid);
    var done = function () { liveForget(sid); renderLive(kk); say("지웠어요"); };
    if (tk) api("/talk/room/delete", { body: { room_id: sid }, token: tk }).then(done, done);
    else api("/talk/room/leave", { body: { room_id: sid, uid: myUid() } }).then(done, done);
    return;
  }
  if (a === "mic") { pt2MicStart(el.getAttribute("data-id") || P.id); return; }

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
  if (a === "tr-toggle") {
    var rid0 = el.getAttribute("data-id") || P.id;
    var nx = !trOn(rid0);
    trSetOn(rid0, nx);
    el.className = "tk-sw" + (nx ? " on" : "");
    say(nx ? ("🌐 자동번역을 켰어요 · " + trxFlag(myLang()) + " " + trxName(myLang())) : "자동번역을 껐어요");
    P.sig = ""; renderMsgs(P.list || [], false);
    return;
  }
  if (a === "noti-toggle") {
    var rid2 = bare(el.getAttribute("data-id") || P.id);
    var nowMuted = !muted(rid2);
    setMuted(rid2, nowMuted);
    el.className = "tk-sw" + (nowMuted ? "" : " on");
    say(nowMuted ? "이 방 알림을 껐어요 🔕" : "이 방 알림을 켰어요 🔔");
    return;
  }
  if (a === "rename") {
    var rid1 = bare(el.getAttribute("data-id") || P.id);
    var cur = roomLabel(rid1, (P.room && P.room.name) || "");
    var v = prompt("이 방을 뭐라고 부를까요?\n(내 기기에서만 바뀝니다)", cur);
    if (v === null) return;
    aliasSet(rid1, (v || "").trim());
    var sb9 = document.querySelector(".sheet-bg"); if (sb9) sb9.remove();
    var ttl9 = document.getElementById("pt2Title");
    if (ttl9) ttl9.textContent = roomLabel(rid1, (P.room && P.room.name) || "");
    say("이름을 바꿨어요");
    return;
  }
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
    var lid = bare(P.id), wasLive = isLive(lid);
    api("/talk/room/leave", { body: { room_id: lid, uid: myUid() } }).then(function () {
      var sb4 = document.querySelector(".sheet-bg"); if (sb4) sb4.remove();
      if (wasLive) liveForget(lid);
      say("방에서 나왔어요");
      refreshRooms();
      location.hash = wasLive ? "#/talk/trans" : "#/talk/open";
    });
    return;
  }
  if (a === "del-room") {
    if (!confirm("방과 모든 대화가 지워져요. 삭제할까요?")) return;
    var did = bare(P.id), wasLive2 = isLive(did);
    api("/talk/room/delete", { body: { room_id: did }, token: tokenOf(did) }).then(function (d) {
      var sb5 = document.querySelector(".sheet-bg"); if (sb5) sb5.remove();
      if (wasLive2) liveForget(did);       /* 서버가 실패해도 내 목록에는 남기지 않는다 */
      if (!d.ok) {
        say((d.error || "서버에서 지우지 못했어요") + " · 내 목록에서는 지웠어요");
        refreshRooms();
        location.hash = "#/talk/trans";
        return;
      }       /* 목록에 남지 않도록 이 기기 기록도 지운다 */
      say("방을 삭제했어요");
      refreshRooms();
      location.hash = wasLive2 ? "#/talk/trans" : "#/talk/open";
    });
    return;
  }

  /* STEP 3 · 맨 위로. 어느 쪽이 실제 스크롤 주체든 상관없도록 둘 다 0 으로 보낸다 */
  if (a === "top") {
    var m = msgsEl();
    if (m) m.scrollTop = 0;
    var v = document.querySelector("#view");
    if (v) v.scrollTop = 0;
    try { window.scrollTo(0, 0); } catch (_e) {}
    /* index5 의 자동 스크롤이 뒤늦게 끌어내리는 걸 눌러 둔다 */
    [80, 240, 600, 1000, 1400].forEach(function (ms) {
      setTimeout(function () {
        var m2 = msgsEl(); if (m2) m2.scrollTop = 0;
        var v2 = document.querySelector("#view"); if (v2) v2.scrollTop = 0;
      }, ms);
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
try { fixTabbar(); } catch (e) {}
window.addEventListener("hashchange", function () { try { fixTabbar(); } catch (e) {} });

if (STEP >= 2 && on()) { try { refreshRooms(); } catch (e) {} }

})();
