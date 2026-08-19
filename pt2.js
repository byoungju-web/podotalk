/* ══════════════════════════════════════════════════════════════
   🍇 PT2 레이어 — 포도톡 서버 방 + @봇  (podotalk.kr)
   ──────────────────────────────────────────────────────────────
   원칙 : index.html 안의 기존 코드는 한 줄도 고치지 않는다.
          여기서 전역 함수를 감싸기(wrap)만 한다.
   결정 : ① 서버 방은 "오픈채팅" 탭 안에서 로컬 방과 섞는다
          ② 웹푸시는 podotalk-api 하나만 쓴다
   붙이는 법 : index.html 의 </body> 바로 위에
              <script src="/pt2.js?v=30"></script>
              (고칠 때마다 v 숫자를 올리면 캐시가 안 물린다)

   ★ 버전 규칙 : 아래 PT2_VER 과 index.html 의 ?v= 숫자를 항상 같게 둔다.
                 어긋나면 설정 화면이 '캐시 불일치' 라고 직접 알려준다.
                 index.html 쪽 도장은 window.PODOTALK_BUILD 한 곳에서만 고친다.

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

var PT2_VER = "74";
var STEP = 7;                                            /* ← 1~7 */
var IMPORT_MODE = "bulk";   /* "bulk" = /talk/import 사용(권장) · "replay" = /talk/message 로 재전송 */
var DEF_API = "https://podotalk-api.hasin7jk.workers.dev";
var PFX = "sv_";                                          /* 서버 방 id 접두어 */
var POLL_MS = 3000;
/* index.html 의 감시 장치가 "제대로 된 pt2 가 왔는지" 확인할 표식.
   숫자가 안 맞으면 index.html 이 캐시를 비우고 스스로 다시 받아온다. */
try { window.PT2_LOADED = PT2_VER; } catch (e) {}

var LOCAL_ROOMS = false;   /* 이 기기에만 저장되는 방을 쓸지. false = 모든 방이 서버 방 */

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

    /* 서버 모드는 기본이 켜짐이다 (on() 참고). 여기서 따로 적어둘 필요가 없다. */
  } catch (e) {}
  LSS("pt2_migrated", "1");
})();

/* 서버 방 쓰기. 예전에는 "1" 이 적혀 있어야 켜졌고, 그 값은 옛 pt_uid
   기록이 있는 기기에서만 자동으로 들어갔다. 그래서 새 브라우저에서는
   꺼진 채로 시작해 index.html 의 옛 화면이 그대로 보였다.
   이제 로컬 방을 안 쓰므로 꺼진 상태는 쓸 데가 없다. 기본을 켜짐으로 둔다. */
function on()      { return STEP >= 1 && LS("pt2_on") !== "0"; }
/* ── 빌드 도장 ──────────────────────────────────────────────────
   index.html 과 pt2.js 는 따로 캐시된다. 하나만 새로 받아지는 일이
   잦아서, 화면만 보고는 어느 쪽이 옛 것인지 알 수가 없었다.
   그래서 ① index.html 이 심어둔 PODOTALK_BUILD 와
          ② 실제로 실행 중인 이 파일의 PT2_VER 과
          ③ index.html 이 불러달라고 적어둔 ?v= 숫자
   셋을 한 줄에 같이 보여준다. ②와 ③이 다르면 캐시가 물린 것이다.
   ────────────────────────────────────────────────────────────── */
var APP_BUILD = (function () { try { return window.PODOTALK_BUILD || ""; } catch (e) { return ""; } })();
var TAG_VER = (function () {
  try {
    var s = document.currentScript;
    if (!s) { var all = document.querySelectorAll('script[src*="pt2.js"]'); s = all[all.length - 1]; }
    var m = s && /[?&]v=([^&"']+)/.exec(s.getAttribute("src") || "");
    return m ? m[1] : "";
  } catch (e) { return ""; }
})();

function stampHtml() {
  var s = '앱 <b>' + esc(APP_BUILD || "?") + '</b> · 레이어 <b>PT2 v' + PT2_VER + '</b>';
  if (TAG_VER && TAG_VER !== PT2_VER) {
    s += '<div style="margin-top:4px;padding:6px 8px;border-radius:7px;background:#FFF4E5;color:#9A5B00;font-weight:700;line-height:1.45">' +
         '⚠️ 캐시 불일치<br>index.html 은 <b>v' + esc(TAG_VER) + '</b> 를 불렀는데 ' +
         '실제로 돈 건 <b>v' + PT2_VER + '</b> 입니다.<br>' +
         '<span style="font-weight:600">둘 중 하나가 옛 파일이에요. 아래 버튼으로 새로 받아보세요.</span>' +
         '<button class="cta" style="background:#fff;color:#9A5B00;border:1.5px solid #E9C88F;box-shadow:none;margin-top:7px" data-pt2="hardreload">🔄 캐시 비우고 새로 받기</button>' +
         '</div>';
  }
  return s;
}

/* 아직 서버로 안 옮긴 옛날 방이 남아 있는지 */
function hasLocalRooms() {
  try {
    var up = upMap();
    return talkRooms().some(function (r) {
      return r.type === "open" && !up[r.id];
    });
  } catch (e) { return false; }
}

/* 폰에 저장된 API 주소를 쓰되, 성한 주소일 때만 쓴다.
   설정에서 주소 칸을 없앤 뒤로 잘못된 값이 저장돼 있으면 고칠 길이 없어
   앱이 통째로 먹통이 된다. 이상하면 기본 주소로 돌아온다. */
function apiBase() {
  var v = (LS("pt2_api") || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[a-z0-9.-]+(\.[a-z]{2,}|\.workers\.dev)(\/[^\s]*)?$/i.test(v)) return v;
  if (v) { try { localStorage.removeItem("pt2_api"); } catch (e) {} }   /* 못 쓸 값은 치운다 */
  return DEF_API.replace(/\/+$/, "");
}
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
  }).then(function (r) {
    /* 바로 .json() 을 부르면 서버가 그 길을 모를 때(404 HTML) 파싱이 터지고
       '연결하지 못했어요' 라는 엉뚱한 말이 나온다. 글로 먼저 받아서 가른다. */
    return r.text().then(function (t) {
      var j = null;
      try { j = JSON.parse(t); } catch (e) {}
      if (j) return j;
      if (r.status === 404) return { ok: false, error: "서버에 " + path + " 기능이 아직 없어요 (404)" };
      if (r.status === 401 || r.status === 403) return { ok: false, error: "권한이 없어요 (" + r.status + ")" };
      return { ok: false, error: "서버 응답을 읽지 못했어요 (" + r.status + ")" };
    });
  }).catch(function () {
    /* 폰이 끊긴 것과 서버가 멈춘 것은 다른 일이다. 같은 말로 뭉뚱그리면
       어디를 봐야 할지 알 수가 없다. */
    var off = false;
    try { off = (navigator.onLine === false); } catch (e) {}
    return { ok: false, error: off ? "인터넷이 끊겼어요. 연결을 확인해 주세요" : "서버에 연결하지 못했어요" };
  });
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
    '.pt2-inline-ic{display:inline-block;width:15px;height:15px;vertical-align:-3px;border-radius:4px;overflow:hidden}',
    '.pt2-lang{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}',
    '.pt2-lchip{background:var(--tk-soft);border:1.5px solid transparent;border-radius:999px;padding:9px 14px;font-size:13.5px;font-weight:800;color:#3a2a4d}',
    '.pt2-lchip.on{border-color:var(--tk-grape);color:var(--tk-grape);background:#fff}',
    '.pt2-legal{display:flex;align-items:center;gap:11px;background:#fff;border:1px solid var(--tk-line);border-radius:13px;padding:14px 15px;margin-top:8px;text-decoration:none;color:#241436}',
    '.pt2-legal-ic{font-size:17px;flex:0 0 auto}',
    '.pt2-legal-t{flex:1;font-size:14.5px;font-weight:800}',
    '.pt2-legal-go{color:#c9bfd8;font-size:19px;font-weight:700}',
    '.pt2-acct{background:#fff;border:1.5px solid var(--tk-grape);border-radius:13px;padding:13px}',
    '.pt2-acct-t{font-weight:900;font-size:14.5px;color:var(--tk-grape)}',
    '.pt2-acct-s{font-size:13px;font-weight:700;color:#5B4A72;margin-top:4px;word-break:break-all}',
    '.pt2-keynote{margin-top:8px;background:var(--tk-soft);border-radius:11px;padding:12px 13px;font-size:13.5px;font-weight:700;color:#3a2a4d;line-height:1.7}',
    '.pt2-keynote b{color:var(--tk-grape);font-weight:900}',
    '.pt2-keybox{margin-top:10px;background:#fff;border:1px solid var(--tk-line);border-radius:13px;padding:12px}',
    '.pt2-keyhd{font-weight:900;font-size:14px;color:#241436;margin-bottom:5px}',
    '.pt2-keyhd span{display:block;font-weight:600;font-size:11.5px;color:var(--tk-sub);margin-top:2px}',
    '.pt2-keylink{display:block;text-align:center;margin-top:9px;padding:10px;border-radius:10px;background:var(--tk-soft);color:var(--tk-grape);font-weight:800;font-size:13px;text-decoration:none}',
    '.pt2-keybox input{width:100%;margin-top:9px;padding:11px 12px;border:1.5px solid var(--tk-line);border-radius:10px;font-size:13px;font-family:ui-monospace,monospace;background:#fff;box-sizing:border-box}',
    '.pt2-mem{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:190px;overflow-y:auto}',
    '.pt2-mem-row{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--tk-line);border-radius:11px;padding:8px 11px}',
    '.pt2-mem-av{width:30px;height:30px;border-radius:10px;overflow:hidden;flex:0 0 auto;background:var(--tk-soft);display:flex;align-items:center;justify-content:center}',
    '.pt2-mem-ini{font-weight:900;font-size:13px;color:var(--tk-grape)}',
    '.pt2-mem-nm{flex:1;min-width:0;font-weight:700;font-size:13.5px;color:#241436;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pt2-mem-row{cursor:pointer}',
    '.pt2-mem-row:active{background:var(--tk-soft)}',
    '.pt2-mem-go{color:#c9bfd8;font-size:18px;font-weight:700;flex:0 0 auto;margin-left:2px}',
    '.pt2-prof-av{width:82px;height:82px;border-radius:26px;overflow:hidden;margin:2px auto 0;background:var(--tk-soft);display:flex;align-items:center;justify-content:center}',
    '.pt2-prof-edit{background:var(--tk-soft);color:var(--tk-grape);border:0;border-radius:8px;padding:6px 10px;font-size:11.5px;font-weight:800}',
    '.pt2-sms-btn{flex:0 0 auto;background:var(--tk-grape);color:#fff;border:0;border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:800}',
    '.pt2-sms-btn.done{background:var(--tk-soft);color:var(--tk-sub)}',
    '.pt2-mem-tag{font-size:10.5px;font-weight:800;color:var(--tk-grape);background:var(--tk-soft);border-radius:6px;padding:2px 6px;flex:0 0 auto}',
    '.pt2-av-img{display:block;width:100%;height:100%;background-size:cover;background-position:center;border-radius:inherit}',
    '.pt2-picklist{display:flex;flex-direction:column;gap:7px;margin-top:10px}',
    '.pt2-pick{display:flex;align-items:center;gap:11px;background:#fff;border:1px solid var(--tk-line);border-radius:12px;padding:10px 12px}',
    '.pt2-pick.joined{border-color:var(--tk-grape);background:var(--tk-soft)}',
    '.pt2-pick{position:relative}',
    '.pt2-pick input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}',
    '.pt2-ck{width:26px;height:26px;border-radius:50%;border:2px solid var(--tk-line);background:#fff;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:transparent;transition:background .12s,border-color .12s}',
    '.pt2-pick input:checked ~ .pt2-ck{background:var(--tk-grape);border-color:var(--tk-grape);color:#fff}',
    '.pt2-pick-av{width:34px;height:34px;border-radius:11px;background:#fff;border:1px solid var(--tk-line);display:flex;align-items:center;justify-content:center;font-size:17px;flex:0 0 auto}',
    '.pt2-pick-mid{flex:1;min-width:0;display:flex;flex-direction:column}',
    '.pt2-pick-nm{font-weight:800;font-size:14px;color:#241436}',
    '.pt2-pick-sub{font-size:11.5px;color:var(--tk-sub);margin-top:1px}',
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
    '.tk-set{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px))}',
    /* 통역방처럼 항목이 많은 설정은 시트가 화면보다 길어진다. 지금까지는
       넘친 만큼 위가 잘려서 방 이름조차 안 보였다. 안에서 넘기게 한다. */
    '.sheet{max-height:86vh;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}'
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
    /* '서버 방 사용' 스위치와 'API 주소' 칸은 뺐다.
       스위치는 끄면 앱이 아무것도 못 하는 상태가 되어 켜둘 수밖에 없고,
       주소는 사용자가 고칠 일이 없는데 화면에 서버 주소만 드러냈다. */
    /* ── 서버 연결 확인 ──
       '연결하지 못했어요' 만으로는 폰 문제인지 서버 문제인지 알 수가 없다.
       실제 이유를 폰 화면에서 바로 보여준다. */
    '<div class="tk-sec" style="margin-top:14px">🩺 서버 연결 확인</div>' +
    '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="diag">지금 확인해 보기</button>' +
    '<div id="pt2Diag" class="pt2-sub" style="margin-top:8px;white-space:pre-wrap"></div>' +

    /* ── 내 계정 ── */
    '<div class="tk-sec" style="margin-top:14px">🔐 내 계정</div>' +
    (acct()
      ? '<div class="pt2-acct"><div class="pt2-acct-t">✅ 구글 계정에 연결됨</div>' +
          '<div class="pt2-acct-s">' + esc(acct().email || acct().name || "") + '</div></div>' +
        '<div class="pt2-sub" style="margin-top:8px">폰을 바꿔도 같은 구글 계정으로 로그인하면 방과 대화가 그대로 돌아옵니다.</div>' +
        '<button class="cta" style="margin-top:10px;background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="g-out">로그아웃</button>'
      : '<div class="pt2-keynote">지금은 <b>이 폰에만</b> 저장돼 있어요.<br>' +
          '폰을 바꾸거나 브라우저 자료를 지우면 <b>방 목록이 사라집니다.</b><br>' +
          '구글 계정으로 한 번 연결해 두면 새 폰에서도 그대로 돌아옵니다.</div>' +
        '<button class="cta grape" style="margin-top:10px" data-pt2="g-in">🔐 구글로 로그인</button>' +
        '<div class="pt2-sub" style="margin-top:8px">비밀번호도 인증번호도 없어요. 크롬에 로그인된 구글 계정을 한 번 고르면 끝입니다.</div>') +

    /* ── 화면 언어 ── */
    '<div class="tk-sec" style="margin-top:14px">🌐 화면 언어</div>' +
    '<div class="pt2-sub">국가를 고르면 앱 화면이 그 나라 말로 바뀌어요. <b>자동</b>이면 폰 시간대(현재 위치)로 알아서 골라요 — 해외에 가면 그 나라 말로 자동 번역됩니다.</div>' +
    '<div class="pt2-lang" data-pt2-noui="1">' +
      UI_LANGS.map(function (x) {
        return '<button class="pt2-lchip' + (uiPick() === x[0] ? " on" : "") + '" data-pt2="ui-lang" data-v="' + x[0] + '">' +
          x[1] + " " + x[2] + "</button>";
      }).join("") +
    "</div>" +
    (uiWhere() ? '<div class="pt2-sub" style="margin-top:8px">📍 지금 위치 · <b>' + esc(uiWhere()) + "</b></div>" : "") +
    '<div class="pt2-sub" style="margin-top:6px">한국어 외 언어는 화면 전체가 자동 번역돼요. <b>API 키 없이도</b> 무료 번역으로 동작합니다. 결과는 이 기기에 저장돼 다음부턴 즉시 표시됩니다.</div>' +

    /* 내 번호를 올려두면 남이 연락처에서 나를 찾아 바로 초대할 수 있다.
       번호 자체는 서버에 가지 않는다. 폰에서 해시로 바꿔 보낸다. */
    '<div class="tk-sec" style="margin-top:14px">📇 연락처로 찾기</div>' +
    '<div class="pt2-sub">내 번호를 등록해 두면, <b>내 번호를 폰에 저장해 둔 사람</b>이 연락처에서 나를 골라 바로 대화방에 부를 수 있어요.<br>번호는 알아볼 수 없는 글자로 바꿔서 보관하고, <b>다른 사람에게 내 번호가 보이지 않습니다.</b></div>' +
    '<div class="tk-field" style="margin-top:8px"><label>내 전화번호</label>' +
      '<input id="pt2Phone" type="tel" inputmode="tel" placeholder="010-0000-0000" value="' + esc(LS("pt2_ph_show") || "") + '"></div>' +
    '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="ph-save">' +
      (myPhoneHash() ? "번호 다시 등록" : "번호 등록하기") + "</button>" +
    (myPhoneHash() ? '<div class="pt2-sub" style="margin-top:6px">✅ 등록돼 있어요. 지우려면 아래를 누르세요.</div>' +
        '<button class="cta" style="margin-top:6px;background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="ph-del">번호 등록 지우기</button>' : "") +
    /* ── 약관 및 정책 ──
       포도랑과 같은 자리에 두되, 문구는 포도톡에 맞춰 다시 썼다.
       포도랑은 기록이 기기에만 남지만 포도톡은 서버에 남기 때문이다. */
    '<div class="tk-sec" style="margin-top:16px">📄 약관 및 정책</div>' +
    '<a class="pt2-legal" href="/terms.html" target="_blank" rel="noopener">' +
      '<span class="pt2-legal-ic">📜</span><span class="pt2-legal-t">이용약관</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="/privacy.html" target="_blank" rel="noopener">' +
      '<span class="pt2-legal-ic">🔒</span><span class="pt2-legal-t">개인정보처리방침</span><span class="pt2-legal-go">›</span></a>' +
    '<div class="pt2-sub" style="margin-top:8px">대화는 서버에 저장돼요. 광고에 쓰거나 팔지 않습니다. 자세한 내용은 개인정보처리방침을 봐주세요.</div>' +

    '<div class="pt2-sub" style="margin-top:14px">' + stampHtml() + "</div>" +
    (STEP >= 6
      ? '<div class="tk-toggle" style="margin-top:10px">🔔 새 메시지 알림<span class="tk-sw" id="pt2PushSw" data-pt2="push"></span></div>' +
        '<button class="cta" style="background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none;margin-top:8px" data-pt2="push-test">알림 테스트 보내기</button>'
      : "") +
    /* '예전 대화 옮기기' 는 뺐다. 이 폰에만 있던 옛 방은 이제 목록에도
       안 나오고, 모든 방이 처음부터 서버에 만들어진다. */
    "";
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

/* ── 아바타 ────────────────────────────────────────────────
   지금까지 목록·헤더에 🍇 라는 글자를 그대로 박아 뒀다. 설정에서 프로필
   사진을 넣어도 그 글자가 계속 보인 이유다.
   ① 프로필 사진이 있으면 그 사진
   ② 없으면 포도톡 앱 아이콘 이미지 (🍇 글자 대신)
   ③ 방이 따로 정한 이모지가 있으면 그 이모지
   ────────────────────────────────────────────────────────── */
var PODO_IMG = "/podotalk-192.png";

function myPhoto() {
  try {
    var a = window.talkAvatar ? window.talkAvatar() : "";
    if (a && window.isPhoto && window.isPhoto(a)) return a;
  } catch (e) {}
  return "";
}
function imgAv(url) {
  return '<span class="pt2-av-img" style="background-image:url(\'' + String(url).replace(/'/g, "%27") + '\')"></span>';
}
function podoAv() { return imgAv(PODO_IMG); }

/* 목록에 쓰는 아바타. 사진 > 방 이모지 > 포도톡 아이콘 */
function roomAv(emoji) {
  var ph = myPhoto();
  if (ph) return imgAv(ph);
  if (emoji && emoji !== "🍇") return esc(emoji);
  return podoAv();
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
      '<div class="tk-av">' + roomAv(r.emoji) + "</div>" +
      '<div class="tk-rmid">' +
        /* 방 이름을 바꾸면 방 안 제목만 바뀌고 목록은 서버 이름 그대로였다.
           목록도 같은 roomLabel 을 쓰게 맞춘다. */
        '<div class="tk-rname">' + esc(roomLabel(r.id, r.name)) +
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
function seg() { return LS("pt2_seg") === "pub" ? "pub" : "gen"; }

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

/* 1:1 방인지. 만든 기기는 표시를 갖고 있고, 초대받아 들어온 기기는
   그 표시가 없으므로 방을 만들 때 붙인 💬 이모지로도 알아본다. */
function isDirectRoom(sid) {
  /* 1:1 통역방도 만들 때 💬 를 쓴다. 이모지만 보고 판단하면 통역방을
     그냥 1:1 채팅방으로 착각해서, 통역방 설정에 있어야 할 자동번역과
     내 언어 고르기가 사라진다. 통역방이면 여기서 먼저 걸러낸다. */
  if (isLive(sid)) return false;
  try { if (LSJ("pt2_direct", {})[sid]) return true; } catch (e) {}
  var r = svRoomOf(sid);
  return !!(r && r.emoji === "💬");
}

/* 방을 나가거나 지운 뒤 돌아갈 목록.
   1:1 을 지웠는데 오픈채팅으로 튀면 내가 어디 있는지 알 수가 없다. */
function backList(sid) {
  if (isLive(sid)) return "#/talk/trans";
  if (isDirectRoom(sid)) return "#/talk/direct";
  return "#/talk/open";
}

/* ── 💬 채팅 탭 : 서버 1:1 방 목록 ── */
function renderDirect() {
  var items = [];
  svRooms().forEach(function (r) {
    if (isLive(r.id)) return;
    if (!isDirectRoom(r.id)) return;
    items.push({ ts: r.last_ts || r.ts || 0, html: svRoomItem(r) });
  });
  items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

  var head = "";
  try { head = tkHeader("채팅", "1:1"); } catch (e) {}
  var tools =
    '<div class="tk-tools">' +
      '<button class="tk-tool primary" data-pt2="new-direct">＋ 1:1 채팅 만들기</button>' +
      '<button class="tk-tool" data-pt2="join-code"># 코드로 입장</button>' +
    "</div>";
  var body = items.length
    ? '<div class="tk-list" id="tkList">' + items.map(function (x) { return x.html; }).join("") + "</div>"
    : '<div class="tk-empty"><div class="ee">💬</div>1:1 대화가 없어요.<br>연락처에서 골라 초대해 보세요!</div>';

  document.querySelector("#view").innerHTML = head + tools + body;
  decorateList();
  markTab("direct");
}

function renderOpen() {
  var cur = seg() === "pub" ? "pub" : "gen";
  var items = (cur === "gen" && LOCAL_ROOMS) ? localOpenItems() : [];
  svRooms().forEach(function (r) {
    if (isLive(r.id)) return;          /* 동시통역방은 통역톡 탭에서만 보인다 */
    if (isDirectRoom(r.id)) return;    /* 1:1 은 💬 채팅 탭에서만 보인다 */
    /* 일반채팅 = 코드로만 들어오는 내 방 · 오픈채팅 = 누구나 보는 공개방 */
    var pub = !r.is_private;
    if (cur === "pub" ? !pub : pub) return;
    items.push({ pin: false, ts: r.last_ts || r.ts || 0, html: svRoomItem(r) });
  });
  items.sort(function (a, b) {
    if (a.pin !== b.pin) return a.pin ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });

  var head = "";
  try { head = tkHeader(cur === "pub" ? "오픈채팅" : "일반채팅", cur === "pub" ? "공개방" : "초대·코드"); } catch (e) {}
  var segBar =
    '<div class="pt2-seg">' +
      '<button class="' + (cur === "gen" ? "on" : "") + '" data-pt2="seg" data-v="gen">💬 일반채팅</button>' +
      '<button class="' + (cur === "pub" ? "on" : "") + '" data-pt2="seg" data-v="pub">🌏 오픈채팅</button>' +
    "</div>";
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
    (LOCAL_ROOMS
      ? '<div class="tk-tools" style="margin-top:-6px">' +
          '<button class="tk-tool" data-action="talk-new" data-mode="group">📱 이 기기에만 만들기</button>' +
          '<button class="tk-tool" data-action="talk-join-code">🔑 초대 링크로 입장</button>' +
        "</div>"
      : "");
  var empty = (cur === "pub")
    ? '<div class="tk-empty"><div class="ee">🌏</div>공개방이 없어요.<br>방을 만들 때 <b>누구나 들어오게</b>를 켜면 여기에 보여요.</div>'
    : '<div class="tk-empty"><div class="ee">💬</div>방이 없어요. 새로 만들어보세요!</div>';
  var body = items.length
    ? '<div class="tk-list" id="tkList">' + items.map(function (x) { return x.html; }).join("") + "</div>"
    : empty;

  document.querySelector("#view").innerHTML = head + segBar + say_ + tools + body;
  decorateList();
  markTab("open");
  var sy = document.getElementById("tkSay");
  if (sy) sy.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); try { runTalkSay(); } catch (_e) {} }
  });
}

function refreshRooms(cb) {
  /* type=mine 을 꼭 같이 받아야 한다. 나머지 셋은 공개방만 돌려주므로
     1:1 처럼 비공개로 만든 방은 내가 들어가 있어도 목록에서 사라진다. */
  api("/talk/rooms?type=mine&uid=" + encodeURIComponent(myUid())).then(function (m) {
  api("/talk/rooms?type=general").then(function (a) {
    api("/talk/rooms?type=study").then(function (b) {
      api("/talk/rooms?type=creator").then(function (c) {
        var all = [].concat(m.rooms || [], a.rooms || [], b.rooms || [], c.rooms || []);
        var seen = {}, out = [];
        all.forEach(function (r) { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; out.push(r); } });
        saveSvRooms(out);
        if (cb) cb(out);
      });
    });
  });
  });
}

window.renderTalkList = function (kind) {
  if (STEP >= 2 && kind === "direct" && on()) {
    renderDirect();
    if (on()) refreshRooms(function () {
      if (location.hash.indexOf("#/talk/direct") === 0) renderDirect();
    });
    return;
  }
  if (STEP >= 2 && (kind === "open" || kind === "general")) {
    if (kind === "general") LSS("pt2_seg", "gen");
    renderOpen();                                    /* 캐시로 즉시 그리고 */
    if (on()) refreshRooms(function () {              /* 서버 응답 오면 다시 */
      if (location.hash.indexOf("#/talk/open") === 0 || location.hash === "#/talk") renderOpen();
    });
    return;
  }
  var r0 = O.renderTalkList.apply(this, arguments);
  try { decorateList(); } catch (e) {}
  return r0;
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
  /* 다중 통역방에서 나왔는데 1:1 칸이 열리면 방금 쓰던 방이 안 보인다.
     그 방이 어느 칸에 속하는지 실어 보낸다. */
  var backTo = isLive(bare(id))
    ? '<span class="tk-back" data-pt2="lang" data-k="' + esc(((liveMeta()[bare(id)] || {}).kind === "multi") ? "multi" : "one") + '">‹</span>'
    : (isDirectRoom(bare(id))
      ? '<span class="tk-back" data-action="talk-tab" data-v="direct">‹</span>'
      : '<span class="tk-back" data-action="talk-tab" data-v="open">‹</span>');
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead pt2-fixhead">' + backTo +
      '<div class="tk-savatar">' + roomAv((P.room && P.room.emoji) || "") + "</div>" +
      '<div class="tk-rh-mid"><div class="tk-hi" id="pt2Title">불러오는 중…</div>' +
        '<div class="tk-hs" id="pt2Sub">서버 방</div></div>' +
      '<div class="tk-racts">' +
        '<button class="tk-ract" data-pt2="top" title="맨 위로">⤒</button>' +
        /* 알림 켜고 끄기는 대화 중에 가장 자주 누르는 것이라 헤더에 둔다.
           설정 시트까지 들어가야 했던 게 불편했다. */
        '<button class="tk-ract" id="pt2BellBtn" data-pt2="noti-toggle" data-id="' + esc(id) + '" title="이 방 알림">' +
          (muted(bare(id)) ? "🔕" : "🔔") + "</button>" +
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
    /* 쇼핑은 포도다(pododa.kr)로 넘기는 문이었다. 포도톡에서 쇼핑까지
       하려면 아직 갈 길이 멀어서 탭에서 뺐다. 필요해지면 되살리면 된다. */
    '<button data-action="talk-tab" data-v="direct" id="tk-tab-direct"><span class="ti">💬</span>채팅</button>' +
    '<button data-pt2="lang" id="tk-tab-lang"><span class="ti">🌐</span>통역톡</button>' +
    '<button data-action="talk-tab" data-v="open" id="tk-tab-open"><span class="ti">💬</span>일반채팅</button>' +
    '<button data-action="talk-tab" data-v="settings" id="tk-tab-settings"><span class="ti">⚙️</span>설정</button>';
}
function markTab(id) {
  fixTabbar();
  ["direct", "lang", "open", "settings"].forEach(function (t) {
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
    '<button class="' + (cur === "multi" ? "on" : "") + '" data-pt2="lseg" data-v="multi">👪 다중<br>동시통역</button>' +
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
      /* 여기만 이모지를 글자로 박아 둬서 프로필 사진이 안 나왔다.
         채팅·오픈채팅 목록과 같은 규칙을 쓰게 맞춘다. */
      '<div class="tk-av trx-av">' + roomAv(kind === "multi" ? "👪" : "💬") + "</div>" +
      '<div class="tk-rmid"><div class="tk-rname">' + esc(roomLabel(r.id, r.name)) +
        '<span class="tk-cnt">👥 ' + (r.members || 1) + "</span>" +
        (r.code ? '<span class="trx-pair">' + esc(r.code) + "</span>" : "") +
        (muted(r.id) ? '<span class="tk-lock">🔕</span>' : "") + "</div>" +
        '<div class="tk-rlast">' + esc(last) + "</div></div>" +
      '<div class="tk-rmeta"><span class="tk-rtime">' + esc(t) + "</span>" +
        (!muted(r.id) && svUnread(r) ? '<span class="pt2-dot"></span>' : "") + "</div></div>" +
      '<button class="pt2-x" data-pt2="rowmenu" data-id="' + esc(PFX + r.id) + '">\u22EE</button></div>';
  }).join("");

  var head = ""; try { head = tkHeader("통역톡", kind === "multi" ? "👪 다중" : "💬 1:1"); } catch (e) {}
  document.querySelector("#view").innerHTML = head + segBarHtml(kind) +
    '<div class="trx-lead">서로 <b>떨어져 있을 때</b> 쓰는 통역이에요. 각자 자기 폰에서 <b>자기 말로만</b> 쓰면, 상대 화면에는 그 사람 언어로 번역돼 보입니다.' +
    (kind === "multi" ? "<br>여러 명이 각각 다른 언어를 골라도 됩니다." : "") + "</div>" +
    '<div class="tk-field"><label>내 언어</label><select class="pt2-langsel" data-pt2-lang="1">' + trxOpts(myLang()) + "</select></div>" +
    '<div class="tk-tools" style="margin-top:12px">' +
      '<button class="tk-tool primary" data-pt2="live-new" data-m="' + kind + '">＋ ' + (kind === "multi" ? "다중 통역방" : "1:1 통역방") + " 만들기</button>" +
      '<button class="tk-tool" data-pt2="join-code"># 코드로 입장</button>' +
    "</div>" +
    (mine.length ? '<div class="tk-tools" style="margin-top:-6px">' +

    "</div>" : "") +
    '<div class="pt2-sub" style="text-align:center;margin:10px 0 0">PT2 v' + PT2_VER + "</div>" +
    (rows ? '<div class="tk-list">' + rows + "</div>"
          : '<div class="tk-empty"><div class="ee">' + (kind === "multi" ? "👪" : "💬") + "</div>아직 통역방이 없어요.<br>＋ 를 누르면 바로 만들어집니다.</div>");
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
    type: "general", uid: myUid(), nick: myNick(), is_private: 1, emoji: multi ? "👪" : "💬"
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
      ic: r.emoji || "", t: r.name, av: 1,
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
          '<div class="tk-ai">' + (it.av ? roomAv(it.ic) : esc(it.ic)) + "</div>" +
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
  /* 초대 링크로 들어온 경우. 코드를 물어보지 않고 그 방으로 바로 넣는다.
     받은 사람 입장에서 링크를 누른 것 자체가 이미 초대의 증거다. */
  /* #/talk/i/열쇠 — 초대받은 사람이 링크를 누른 경우.
     서버가 방에 넣고 번호 등록까지 대신 끝낸다. 상대는 아무것도 안 한다. */
  if (sub === "i" && arg && on()) {
    try { document.querySelector("#view").innerHTML = '<div class="tk-empty"><div class="ee">🍇</div>초대를 확인하는 중…</div>'; } catch (e) {}
    api("/talk/invite/claim", { body: { token: String(arg).trim(), uid: myUid(), nick: myNick() } })
      .then(function (d) {
        if (d && d.ok && d.room_id) {
          say("『" + (d.name || "대화방") + "』에 들어왔어요 🍇");
          refreshRooms();
          location.replace("#/talk/room/" + PFX + d.room_id);
          return;
        }
        try {
          document.querySelector("#view").innerHTML =
            '<div class="tk-empty"><div class="ee">⚠️</div>' + esc((d && d.error) || "초대 링크를 쓸 수 없어요") +
            '<br><span style="font-size:12px">보낸 분에게 새 링크를 받아주세요</span></div>';
        } catch (e2) {}
      });
    return;
  }
  if (sub === "join" && arg && on()) {
    var key = String(arg).trim();
    try { document.querySelector("#view").innerHTML = '<div class="tk-empty"><div class="ee">🍇</div>방을 여는 중…</div>'; } catch (e) {}
    api("/talk/room?code=" + encodeURIComponent(key.toUpperCase())).then(function (d) {
      if (d && d.ok && d.room) { location.replace("#/talk/room/" + PFX + d.room.id); return; }
      /* 코드가 아니라 방 id 를 그대로 담아 보낸 링크일 수도 있다 */
      api("/talk/room?id=" + encodeURIComponent(key)).then(function (e2) {
        if (e2 && e2.ok && e2.room) { location.replace("#/talk/room/" + PFX + e2.room.id); return; }
        try {
          document.querySelector("#view").innerHTML =
            '<div class="tk-empty"><div class="ee">⚠️</div>초대 링크가 만료됐거나 잘못됐어요<br>' +
            '<span style="font-size:12px">보낸 분에게 새 링크를 받아주세요</span></div>';
        } catch (e3) {}
      });
    });
    return;
  }
  if (sub === "new") { renderNew(); return; }
  if (sub === "profile") { renderProfile(); return; }
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

/* ══════════════ 친구 초대 ══════════════
   솔직히 짚고 갈 것 : 연락처에서 사람을 고른다고 그 사람이 방에 들어와지지는
   않는다. 남의 폰을 이쪽에서 조작할 방법은 없다. 그래서 여기서 하는 일은
   "고른 사람에게 초대 링크를 문자로 쏘는 것" 까지다. 상대가 그 링크를 누르면
   코드를 입력할 필요 없이 바로 방으로 들어온다.

   연락처 읽기는 Contact Picker API 를 쓴다. 안드로이드 크롬에서만 동작하고
   아이폰·PC 에는 없다. 없으면 공유하기(카톡·문자)로 자연스럽게 넘어간다. */
function hasPicker() {
  try { return !!(navigator.contacts && navigator.contacts.select && window.ContactsManager); }
  catch (e) { return false; }
}
function inviteLink(sid, code) {
  var base = location.origin || "https://podotalk.kr";
  return base + "/#/talk/join/" + encodeURIComponent(code || sid);
}
function inviteText(name, sid, code) {
  return "🍇 포도톡 『" + (name || "대화방") + "』에 초대합니다.\n" +
         "아래 링크를 누르면 바로 들어와져요.\n" + inviteLink(sid, code);
}

/* 문자 앱을 연다. 안드로이드는 sms:번호?body=내용 을 알아듣는다 */
function smsTo(nums, body) {
  var to = (nums || []).join(",");
  try { location.href = "sms:" + to + "?body=" + encodeURIComponent(body); }
  catch (e) { say("문자 앱을 열지 못했어요"); }
}

/* 번호 등록을 권하는 안내창은 없앴다. 초대 링크를 한 번 누르면 서버가
   등록까지 알아서 끝내므로, 사용자가 알아야 할 일이 아니다. */
function pickContacts(sid, code, name) {
  if (!hasPicker()) {
    say("이 기기에서는 연락처를 직접 열 수 없어요. 공유하기로 보내주세요");
    shareInvite(sid, code, name);
    return;
  }
  navigator.contacts.select(["name", "tel"], { multiple: true }).then(function (list) {
    if (!list || !list.length) return;
    var picked = [];
    list.forEach(function (c) {
      var t = (c.tel || []).filter(Boolean)[0];
      if (!t) return;
      picked.push({ name: (c.name || []).filter(Boolean)[0] || String(t), tel: String(t), uid: "", hash: "" });
    });
    if (!picked.length) { say("고른 분들의 전화번호가 없어요"); return; }

    say("확인하는 중…");
    matchContacts(picked, function (arr) {
      var uids = arr.filter(function (c) { return c.uid; }).map(function (c) { return c.uid; });
      var rest = arr.filter(function (c) { return !c.uid; });
      var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();

      /* 예전에는 고르자마자 문자 앱으로 넘어갔다. 이제는 넘어가지 않는다.
         포도톡을 쓰는 분은 그대로 방에 넣고, 안 쓰는 분만 보내기 화면을 띄운다. */
      var after = function () {
        if (rest.length) smsSheet(rest, name, sid, code);
      };
      if (!uids.length) { after(); return; }

      api("/talk/room/invite", { token: tokenOf(sid), body: { room_id: sid, uids: uids, uid: myUid() } })
        .then(function (r) {
          if (r && r.ok) { say(uids.length + "분을 방에 초대했어요 🍇"); refreshRooms(); }
          else { rest = rest.concat(arr.filter(function (c) { return c.uid; })); }
          after();
        });
    });
  }).catch(function () { say("연락처를 불러오지 못했어요"); });
}

function shareInvite(sid, code, name) {
  var txt = inviteText(name, sid, code);
  if (navigator.share) {
    navigator.share({ title: "포도톡 초대", text: txt }).catch(function () {});
    return;
  }
  try { navigator.clipboard.writeText(txt); say("초대 문구를 복사했어요. 카톡에 붙여넣으세요 📋"); }
  catch (e) { prompt("이 내용을 복사해서 보내세요", txt); }
}

/* 초대 문자를 눌러서 보내는 화면.
   문자 앱을 저절로 여는 것은 브라우저가 막기 때문에 버튼이 반드시 필요하다. */
function smsSheet(list, name, sid, code) {
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>처음 초대하는 분</h3>" +
    '<div class="sd">아직 포도톡을 안 쓰는 분이에요. 링크를 한 번만 누르면 <b>가입도 코드도 없이</b> 바로 들어와지고, 다음부터는 연락처에서 고르는 것만으로 초대됩니다.</div>' +
    '<div class="pt2-mem" id="pt2Sms" style="max-height:250px">' +
      '<div class="pt2-sub">초대 링크를 만드는 중…</div>' +
    "</div>" +
    '<button class="cta" style="margin-top:12px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);

  /* 사람마다 전용 링크를 받아 각자 보내기 버튼을 만든다.
     한 통에 여러 명을 묶으면 누가 눌렀는지 알 수 없어 등록을 대신해줄 수 없다. */
  makeInvites(sid, list, function (tokens) {
    var box = document.getElementById("pt2Sms");
    if (!box) return;
    box.innerHTML = list.map(function (c) {
      var tk = c.hash && tokens[c.hash];
      var body = tk ? keyText(name, tk) : inviteText(name, sid, code);
      return '<div class="pt2-mem-row">' +
        '<span class="pt2-mem-av"><span class="pt2-mem-ini">' + esc((c.name || "?").slice(0, 1)) + "</span></span>" +
        '<span class="pt2-mem-nm">' + esc(c.name || c.tel) + "</span>" +
        '<button class="pt2-sms-btn" data-pt2="sms-one" data-num="' + esc(normPhone(c.tel)) + '" data-body="' + esc(body) + '">📩 보내기</button>' +
        "</div>";
    }).join("");
  });
}

/* 사람마다 다른 초대 링크를 만든다.
   이 링크를 누르면 방 입장과 번호 등록이 한꺼번에 끝난다.
   서버에 이 기능이 없으면(404) 예전처럼 공용 코드 링크로 돌아간다. */
function makeInvites(sid, list, cb) {
  var hs = list.map(function (c) { return c.hash; }).filter(Boolean);
  if (!hs.length) { cb({}); return; }
  api("/talk/invite/create", { body: { room_id: sid, uid: myUid(), hashes: hs } })
    .then(function (d) { cb((d && d.ok && d.tokens) || {}); });
}
function keyLink(tk) {
  return (location.origin || "https://podotalk.kr") + "/#/talk/i/" + encodeURIComponent(tk);
}
function keyText(name, tk) {
  return "🍇 포도톡 『" + (name || "대화방") + "』에 초대합니다.\n" +
         "아래를 한 번만 누르면 바로 들어와져요. 가입도 코드도 없어요.\n" + keyLink(tk);
}

function inviteSheet(sid, code, name) {
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>친구 초대</h3>" +
    '<div class="sd">초대 링크를 받은 사람은 <b>코드를 입력하지 않고</b> 바로 들어와요.</div>' +
    (hasPicker()
      ? '<button class="cta grape" data-pt2="inv-pick" data-id="' + esc(sid) + '" data-code="' + esc(code || "") + '" data-name="' + esc(name || "") + '">📇 연락처에서 고르기</button>'
      : '<div class="pt2-sub" style="margin-bottom:8px">📇 연락처 열기는 안드로이드 크롬에서만 됩니다. 아래 공유하기를 쓰세요.</div>') +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-grape);box-shadow:none" data-pt2="inv-share" data-id="' + esc(sid) + '" data-code="' + esc(code || "") + '" data-name="' + esc(name || "") + '">💬 카톡·문자로 보내기</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="inv-copy" data-id="' + esc(sid) + '" data-code="' + esc(code || "") + '" data-name="' + esc(name || "") + '">🔗 초대 링크 복사</button>' +
    (code ? '<div class="tk-code" style="margin-top:10px">초대 코드 <b>' + esc(code) + "</b></div>" : "") +
    '<button class="cta" style="margin-top:12px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
}

/* index.html 의 가짜 친구 목록(민지·준호…)을 진짜 초대로 갈아끼운다 */
window.openInviteFriends = function (id) {
  var nm = "", cd = "";
  try { var r = findRoom(id); if (r) { nm = r.name || ""; cd = r.pw || r.code || ""; } } catch (e) {}
  inviteSheet(id, cd, nm);
};

/* ══════════════ 새 채팅 만들기 (전체 화면) ══════════════
   작은 시트에 방 이름 한 칸만 있으면, 만들고 나서 초대를 또 찾아가야 한다.
   여기서 종류·이름·초대할 사람까지 한 화면에서 정하고 한 번에 만든다. */
var NEWC = { kind: "direct", picked: [] };

function newScreen(kind) {
  /* direct = 1:1 채팅 · group = 그룹방 · live1 = 1:1 통역방 · livemulti = 다중 통역방
     통역방도 만드는 절차는 같다. 그런데 지금까지 통역방만 브라우저 기본
     입력창(prompt)을 써서, 주소가 그대로 뜨는 낯선 화면이 나왔다. */
  NEWC.kind = ({ group: 1, open: 1, live1: 1, livemulti: 1 })[kind] ? kind : "direct";
  NEWC.picked = [];
  NEWC.name = ""; NEWC.intro = ""; NEWC.pub = (NEWC.kind === "open");
  location.hash = "#/talk/new";
}

function pickRow(c, i) {
  /* 이름만 보여준다. 전화번호나 '문자로 초대' 같은 군더더기는 빼고,
     오른쪽 끝 동그라미로 고르고 푼다. 1:1 이든 여러 명이든 같은 모양이다. */
  var joined = !!c.uid;
  return '<label class="pt2-pick' + (joined ? " joined" : "") + '">' +
    '<input type="checkbox" data-pt2="pick-ck" data-i="' + i + '"' + (c.on ? " checked" : "") + ">" +
    '<span class="pt2-pick-av">' + (joined ? podoAv() : "👤") + "</span>" +
    '<span class="pt2-pick-mid"><span class="pt2-pick-nm">' + esc(c.name || c.tel) + "</span>" +
      (joined ? '<span class="pt2-pick-sub">포도톡 사용 중</span>' : "") + "</span>" +
    '<span class="pt2-ck">✓</span>' +
    "</label>";
}

function newIsLive() { return NEWC.kind === "live1" || NEWC.kind === "livemulti"; }
function newIsSolo() { return NEWC.kind === "direct" || NEWC.kind === "live1"; }

function renderNew() {
  var isD = newIsSolo();
  var lv = newIsLive();
  var TT = { direct: ["새 1:1 채팅", "둘이서 이야기해요"],
             group: ["새 그룹방", "여러 명이 함께 이야기해요"],
             open: ["새 오픈채팅방", "누구나 찾아 들어올 수 있어요"],
             live1: ["새 1:1 동시통역톡", "서로 다른 말로 둘이 이야기해요"],
             livemulti: ["새 다중동시통역방", "여러 나라 사람이 함께 이야기해요"] }[NEWC.kind];
  var picks = NEWC.picked;
  var list = picks.length
    ? '<div class="pt2-sub" style="margin:10px 0 -2px">동그라미를 눌러 고르세요. 체크한 사람만 초대돼요.</div>' +
      '<div class="pt2-picklist">' + picks.map(pickRow).join("") + "</div>"
    : '<div class="pt2-sub" style="margin:8px 0 2px">아직 고른 사람이 없어요. 위 버튼으로 연락처에서 고르세요.</div>';

  /* 1:1 은 고른 사람 이름이 곧 방 이름이라 입력칸이 필요 없다.
     연락처를 못 여는 기기(아이폰·PC)에서만 이름을 직접 받는다. */
  var needName = true;
  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead"><span class="tk-back" data-pt2="new-back">‹</span>' +
      '<div class="tk-rh-mid"><div class="tk-hi">' + TT[0] + "</div>" +
      '<div class="tk-hs">' + TT[1] + "</div></div></div>" +
    '<div class="tk-set">' +
      (needName
        ? '<div class="tk-field"><label>방 이름</label><input id="pt2CName" maxlength="40" value="' + esc(NEWC.name || "") + '" placeholder="' +
            (lv ? (isD ? "예: 사장님과 통역방" : "예: 가족 통역방")
                : (isD ? "연락처를 고르면 자동으로 채워져요" : "예: 부산 사장님 모임")) + '" autocomplete="off"></div>'
        : "") +
      (isD || lv ? "" :
        '<div class="tk-field"><label>한 줄 소개 (선택)</label><input id="pt2CIntro" maxlength="120" value="' + esc(NEWC.intro || "") + '" placeholder="무슨 얘기를 하는 방인가요" autocomplete="off"></div>' +
        /* 공개 스위치는 오픈채팅방에서만 보여준다. 일반 그룹방에서는
           실수로 한 번 켜면 그 방 대화가 통째로 남에게 보이고, 되돌린다고
           이미 본 것이 지워지지도 않는다. */
        (NEWC.kind === "open"
          ? '<div class="tk-toggle">🌏 누구나 들어오게<span class="tk-sw' + (NEWC.pub ? " on" : "") + '" data-pt2="new-pub"></span></div>' +
            '<div class="pt2-sub" style="margin-top:4px">' +
              (NEWC.pub
                ? "켜져 있어요. 포도톡을 여는 <b>누구나</b> 이 방을 찾아 들어오고 대화를 볼 수 있습니다."
                : "🔒 꺼두면 <b>초대 링크나 코드를 받은 사람만</b> 들어와요.") + "</div>"
          : '<div class="pt2-sub" style="margin-top:2px">🔒 초대 링크나 코드를 받은 사람만 들어와요.</div>')) +
      (lv ? '<div class="pt2-sub" style="margin-top:2px">각자 자기 말로 쓰면 상대 화면에는 그 사람 언어로 번역돼 보여요. 자동번역이 켜진 채로 시작합니다.</div>'
          : (isD ? '<div class="pt2-sub" style="margin-top:2px">입장 코드는 없어요. 초대받은 사람이 바로 들어옵니다.</div>' : "")) +

      '<div class="tk-sec" style="margin-top:16px">초대할 사람</div>' +
      (hasPicker()
        ? '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-grape);box-shadow:none" data-pt2="new-pick">📇 연락처에서 고르기</button>'
        : '<div class="pt2-sub">📇 연락처 열기는 안드로이드 크롬에서만 됩니다.</div>') +
      /* 연락처에 없는 사람도 부를 수 있어야 한다. 방을 만든 뒤 링크를 건네는 길. */
      '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="new-link">🔗 연락처 없이 · 초대 링크로 부르기</button>' +
      list +

      '<button class="cta grape" style="margin-top:16px" data-pt2="new-go">' +
        (isD ? "1:1 채팅 만들기" : "그룹방 만들기") + "</button>" +
      '<div class="pt2-sub" style="margin-top:8px"><span class="pt2-inline-ic">' + podoAv() +
        '</span> 표시가 있는 분은 방에 바로 들어와요. 나머지는 만든 뒤 문자로 초대 링크가 나갑니다.</div>' +
    "</div>";
  markTab(newIsLive() ? "trans" : (NEWC.kind === "direct" ? "direct" : "open"));
  /* 예전에는 방 이름 칸에 저절로 커서를 넣었다. 그러면 화면을 열자마자
     자판이 올라와 아래 절반을 덮어버린다. 칸을 눌렀을 때만 올라오게 둔다. */
}

/* 연락처 고르기 → 누가 가입자인지 확인 → 체크 목록에 쌓기 */
/* 화면을 다시 그리면 입력칸이 새로 만들어져 적어둔 글자가 날아간다.
   그리기 전에 항상 값을 챙겨 둔다. */
function newKeep() {
  var a = document.getElementById("pt2CName");
  var b = document.getElementById("pt2CIntro");
  if (a) NEWC.name = a.value;
  if (b) NEWC.intro = b.value;
}

function newPick() {
  if (!hasPicker()) { say("이 기기에서는 연락처를 열 수 없어요"); return; }
  newKeep();
  navigator.contacts.select(["name", "tel"], { multiple: true }).then(function (out) {
    if (!out || !out.length) return;
    var add = [];
    out.forEach(function (c) {
      var tel = (c.tel || []).filter(Boolean)[0];
      if (!tel) return;
      var nm = (c.name || []).filter(Boolean)[0] || tel;
      add.push({ name: nm, tel: String(tel), on: true, uid: "", hash: "" });
    });
    if (!add.length) { say("고른 분들의 전화번호가 없어요"); return; }
    say("확인하는 중…");
    matchContacts(add, function (arr) {
      var have = {};
      NEWC.picked.forEach(function (c) { have[normPhone(c.tel)] = 1; });
      arr.forEach(function (c) { if (!have[normPhone(c.tel)]) NEWC.picked.push(c); });
      if (newIsSolo()) {
        if (NEWC.picked.length > 1) {
          NEWC.picked = NEWC.picked.slice(0, 1);
          say("1:1 방은 한 분만 초대할 수 있어요");
        }
        if (NEWC.picked[0] && NEWC.kind === "direct") NEWC.name = NEWC.picked[0].name;
      }
      renderNew();
    });
  }).catch(function () { say("연락처를 불러오지 못했어요"); });
}

/* 만들기 : 방 생성 → 가입자는 서버가 바로 넣고 → 나머지는 문자 한 통으로 */
function newGo() {
  newKeep();
  var isD = newIsSolo();
  var lv = newIsLive();
  var multi = NEWC.kind === "livemulti";
  var nm = (NEWC.name || "").trim();
  if (NEWC.kind === "direct" && !nm && NEWC.picked[0]) nm = NEWC.picked[0].name;
  if (!nm) { say("방 이름을 입력해 주세요"); return; }
  var on = NEWC.picked.filter(function (c) { return c.on; });

  say(lv ? "통역방을 만드는 중…" : "방을 만드는 중…");
  api("/talk/room/create", { body: {
    name: nm,
    intro: lv ? "각자 자기 말로 쓰면 상대 언어로 번역됩니다" : (NEWC.intro || "").trim(),
    type: "general", uid: myUid(), nick: myNick(),
    /* 1:1 과 통역방은 반드시 비공개다. 공개로 두면 둘만의 방이 모두의
       오픈채팅 목록에 뜬다. 코드를 안 받는 것과 목록에 안 뜨는 것은 다른 얘기다. */
    /* 오픈채팅방에서 스위치를 켠 경우에만 공개다. 나머지는 모두 비공개. */
    is_private: (NEWC.kind === "open" && NEWC.pub) ? 0 : 1,
    emoji: lv ? (multi ? "👪" : "💬") : (isD ? "💬" : "🍇")
  }}).then(function (d) {
    if (!d || !d.ok) { say((d && d.error) || "방을 만들지 못했어요"); return; }
    saveToken(d.id, d.token);
    if (lv) {
      /* 통역방으로 등록해 둬야 통역톡 탭에 뜨고, 설정에도 자동번역이 나온다 */
      liveAdd(d.id);
      liveMetaSet(d.id, { kind: multi ? "multi" : "one", name: nm, code: d.code || "", ts: Date.now() });
      trSetOn(PFX + d.id, true);
    } else if (NEWC.kind === "direct") {
      try { var dm = LSJ("pt2_direct", {}); dm[d.id] = 1; LSS("pt2_direct", JSON.stringify(dm)); } catch (e) {}
    }

    var uids = on.filter(function (c) { return c.uid; }).map(function (c) { return c.uid; });
    var sms  = on.filter(function (c) { return !c.uid; });

    var finish = function () {
      refreshRooms();
      /* 통역방은 목록에 남는 편이 낫다. 상대가 들어오기 전에는 할 일이 없다. */
      if (lv) { location.hash = "#/talk/trans"; try { renderLive(multi ? "multi" : "one"); } catch (e) {} }
      else location.hash = "#/talk/room/" + PFX + d.id;
      /* 예전에는 여기서 문자 앱을 저절로 열었다. 그런데 화면을 옮긴 뒤
         저절로 여는 sms: 이동은 크롬이 막는다. 그래서 문자가 안 갔다.
         이제는 눌러서 보내도록 화면을 띄운다. 누르는 동작이 있어야 열린다. */
      setTimeout(function () {
        if (sms.length) smsSheet(sms, nm, d.id, d.code || "");
        else if (!uids.length) inviteSheet(d.id, d.code || "", nm);
      }, 400);
    };

    if (!uids.length) { say("방을 만들었어요 🍇"); finish(); return; }
    api("/talk/room/invite", { token: d.token, body: { room_id: d.id, uids: uids, uid: myUid() } })
      .then(function (r) {
        if (r && r.ok) say(uids.length + "분을 방에 초대했어요 🍇");
        else {
          /* 워커에 초대 기능이 아직 없으면 그분들도 문자로 돌린다 */
          sms = sms.concat(on.filter(function (c) { return c.uid; }));
          say("바로 초대는 아직 준비 중이라 문자로 보낼게요");
        }
        finish();
      });
  });
}

/* ══════════════ 구글 로그인 ══════════════
   포도톡은 폰 안의 무작위 uid 로 사람을 구분한다. 그래서 폰을 바꾸면
   서버가 그 사람을 몰라 방 목록이 텅 빈다. 구글 계정을 그 uid 에 묶어두면
   새 폰에서 버튼 한 번으로 방이 전부 돌아온다.

   ★ 아래 CLIENT_ID 를 본인 것으로 바꿔야 동작한다. 받는 방법은
     설정 화면 안내에 적어뒀다. 워커에도 같은 값을 넣어야 한다.
   ────────────────────────────────────────────────────────────── */
var G_CLIENT_ID = "1007117932498-2cea0161fftm4ed4ndp5tbkv3899kgpm.apps.googleusercontent.com";

function gReady() { return !!(G_CLIENT_ID && window.google && google.accounts && google.accounts.id); }
function acct() { return LSJ("pt2_acct", null); }

/* 구글 스크립트를 한 번만 불러온다 */
var gLoading = false;
function gLoad(cb) {
  if (!G_CLIENT_ID) { cb(false); return; }
  if (gReady()) { cb(true); return; }
  if (gLoading) { setTimeout(function () { gLoad(cb); }, 300); return; }
  gLoading = true;
  var sc = document.createElement("script");
  sc.src = "https://accounts.google.com/gsi/client";
  sc.async = true; sc.defer = true;
  sc.onload = function () { cb(gReady()); };
  sc.onerror = function () { cb(false); };
  document.head.appendChild(sc);
}

/* 로그인 결과를 서버에 보내 계정과 uid 를 묶는다 */
function gSend(idToken) {
  say("로그인 확인 중…");
  api("/talk/auth/google", { body: { id_token: idToken, uid: myUid() } }).then(function (d) {
    if (!d || !d.ok) { say((d && d.error) || "로그인하지 못했어요"); return; }
    /* 서버가 정해준 계정 uid 로 이 폰을 맞춘다. 이게 곧 계정 이어받기다. */
    try { window.DB.set("pododa_uid", d.uid); } catch (e) {}
    LSS("pt2_acct", JSON.stringify({ email: d.email || "", name: d.name || "" }));
    say(d.moved ? d.moved + "개 방을 계정으로 옮겼어요 🍇" : "로그인했어요 🍇");
    refreshRooms(function () { try { renderTalkSettings(); } catch (e2) {} });
  });
}

function gLogin() {
  if (!G_CLIENT_ID) {
    alert("아직 구글 로그인 준비가 안 됐어요.\n\npt2.js 맨 위의 G_CLIENT_ID 에 구글 클라이언트 ID 를 넣고, 워커에도 GOOGLE_CLIENT_ID 를 넣어야 동작합니다.");
    return;
  }
  gLoad(function (ok2) {
    if (!ok2) { say("구글 로그인을 불러오지 못했어요"); return; }
    try {
      google.accounts.id.initialize({
        client_id: G_CLIENT_ID,
        callback: function (res) { if (res && res.credential) gSend(res.credential); },
        auto_select: false
      });
      /* 안드로이드 크롬은 이미 구글에 로그인돼 있어 보통 한 번 누르면 끝난다 */
      google.accounts.id.prompt(function (n) {
        if (n && n.isNotDisplayed && n.isNotDisplayed()) {
          say("구글 계정 선택 창이 막혔어요. 크롬에서 구글에 로그인돼 있는지 확인해 주세요");
        }
      });
    } catch (e) { say("구글 로그인을 열지 못했어요"); }
  });
}

function gLogout() {
  if (!confirm("로그아웃하면 이 폰에서 방 목록이 비워집니다.\n다시 로그인하면 그대로 돌아옵니다.\n\n로그아웃할까요?")) return;
  try { localStorage.removeItem("pt2_acct"); } catch (e) {}
  /* uid 를 새로 만들어 이 폰을 빈 상태로 되돌린다. 서버 자료는 지우지 않는다. */
  try { window.DB.set("pododa_uid", "u_" + Math.random().toString(36).slice(2, 10)); } catch (e2) {}
  say("로그아웃했어요");
  refreshRooms(function () { try { renderTalkSettings(); } catch (e3) {} });
}

/* ══════════════ 화면 언어 ══════════════
   메시지 번역과는 다른 이야기다. 이건 버튼·안내문 같은 화면 글자를
   통째로 다른 나라 말로 바꾸는 것이다.

   ① 무료 번역기를 쓴다. API 키가 없어도 돌아간다.
   ② 한 번 번역한 문장은 이 기기에 적어둔다. 다음부터는 곧바로 나온다.
   ③ 키를 넣어두면 그걸 먼저 쓴다. 번역 품질이 더 낫다.
   ────────────────────────────────────────────────────────────── */
var UI_LANGS = [
  ["auto", "🌐", "자동(위치 따름)"],
  ["ko", "🇰🇷", "한국어"],
  ["en", "🇺🇸", "English"],
  ["zh", "🇨🇳", "中文"],
  ["hi", "🇮🇳", "हिन्दी"],
  ["es", "🇪🇸", "Español"],
  ["fr", "🇫🇷", "Français"],
  ["de", "🇩🇪", "Deutsch"]
];

/* 폰 시간대로 지금 어느 나라에 있는지 어림한다.
   위치 권한을 묻지 않아도 되고, 해외에 나가면 저절로 바뀐다. */
var TZ_LANG = {
  Seoul: ["ko", "대한민국"], Pyongyang: ["ko", "조선"],
  Tokyo: ["ja", "일본"], Shanghai: ["zh", "중국"], Chongqing: ["zh", "중국"],
  Hong_Kong: ["zh", "홍콩"], Taipei: ["zh", "대만"], Macau: ["zh", "마카오"],
  Kolkata: ["hi", "인도"], Calcutta: ["hi", "인도"],
  Madrid: ["es", "스페인"], Mexico_City: ["es", "멕시코"], Bogota: ["es", "콜롬비아"],
  Buenos_Aires: ["es", "아르헨티나"], Santiago: ["es", "칠레"], Lima: ["es", "페루"],
  Paris: ["fr", "프랑스"], Brussels: ["fr", "벨기에"],
  Berlin: ["de", "독일"], Vienna: ["de", "오스트리아"], Zurich: ["de", "스위스"],
  New_York: ["en", "미국"], Chicago: ["en", "미국"], Denver: ["en", "미국"],
  Los_Angeles: ["en", "미국"], Phoenix: ["en", "미국"], Anchorage: ["en", "미국"],
  Honolulu: ["en", "미국"], Toronto: ["en", "캐나다"], Vancouver: ["en", "캐나다"],
  London: ["en", "영국"], Dublin: ["en", "아일랜드"],
  Sydney: ["en", "호주"], Melbourne: ["en", "호주"], Auckland: ["en", "뉴질랜드"],
  Singapore: ["en", "싱가포르"], Manila: ["en", "필리핀"]
};

function tzGuess() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    var city = tz.split("/").pop();
    if (TZ_LANG[city]) return TZ_LANG[city];
  } catch (e) {}
  try {
    var nl = (navigator.language || "").slice(0, 2).toLowerCase();
    for (var i = 1; i < UI_LANGS.length; i++) if (UI_LANGS[i][0] === nl) return [nl, ""];
  } catch (e2) {}
  return ["ko", "대한민국"];
}

function uiPick() { return LS("pt2_ui") || "auto"; }
function uiLang() {
  var p = uiPick();
  if (p !== "auto") return p;
  var g = tzGuess()[0];
  /* 자동인데 우리가 화면을 준비하지 않은 말이면 영어로 간다 */
  for (var i = 1; i < UI_LANGS.length; i++) if (UI_LANGS[i][0] === g) return g;
  return "en";
}
function uiWhere() {
  var g = tzGuess();
  return g[1] ? g[1] : "";
}

/* 번역해 둔 것 보관 — 언어별로 나눠 담는다 */
function uiCache(l) { try { return JSON.parse(LS("pt2_uic_" + l) || "{}"); } catch (e) { return {}; } }
function uiCacheSave(l, o) { try { LSS("pt2_uic_" + l, JSON.stringify(o)); } catch (e) {} }

var uiQ = [], uiBusy = false, uiSeen = {}, uiPaint = null;

/* 키가 있으면 키를 먼저, 없으면 무료 번역기 */
/* 키는 설정 위쪽 한 곳에서만 받는다. 그 값은 index.html 의 keyFor 가
   갖고 있으므로(포도야와 공유) 여기서 따로 저장하지 않고 그것을 읽는다. */
function aiKey(which) {
  try { if (window.keyFor) return window.keyFor(which) || ""; } catch (e) {}
  try { return (window.DB && window.DB.get("fl_key_" + which)) || ""; } catch (e2) { return ""; }
}
function uiTranslateOne(text, lang, done) {
  var gk = aiKey("gemini");
  if (gk) { geminiTr(text, lang, gk, done, function () { freeTr(text, lang, done); }); return; }
  var ck = aiKey("claude");
  if (ck) { claudeTr(text, lang, ck, done, function () { freeTr(text, lang, done); }); return; }
  freeTr(text, lang, done);
}
function freeTr(text, lang, done) {
  trxGoogle(text, "ko", lang, done, function () {
    trxMyMemory(text, "ko", lang, done, function () { done(""); });
  });
}
function trPrompt(lang) {
  var nm = { en: "English", zh: "Chinese", hi: "Hindi", es: "Spanish", fr: "French", de: "German", ja: "Japanese" }[lang] || lang;
  return "Translate the Korean UI text into " + nm +
    ". Keep emoji and numbers as they are. Reply with the translation only, no quotes, no explanation.";
}
function geminiTr(text, lang, key, ok, fail) {
  fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: trPrompt(lang) }] },
      contents: [{ role: "user", parts: [{ text: text }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400 }
    })
  }).then(function (r) { return r.json(); }).then(function (d) {
    var t = d && d.candidates && d.candidates[0] && d.candidates[0].content &&
            d.candidates[0].content.parts && d.candidates[0].content.parts[0];
    ok(String((t && t.text) || "").trim() || "");
  })["catch"](fail);
}
function claudeTr(text, lang, key, ok, fail) {
  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest", max_tokens: 400,
      system: trPrompt(lang), messages: [{ role: "user", content: text }]
    })
  }).then(function (r) { return r.json(); }).then(function (d) {
    var t = d && d.content && d.content[0] && d.content[0].text;
    ok(String(t || "").trim() || "");
  })["catch"](fail);
}

function uiStep() {
  var job = uiQ.shift();
  if (!job) { uiBusy = false; return; }
  uiBusy = true;
  uiTranslateOne(job.t, job.l, function (out) {
    if (out) {
      var c = uiCache(job.l); c[job.t] = out; uiCacheSave(job.l, c);
      if (uiPaint) clearTimeout(uiPaint);
      uiPaint = setTimeout(uiPaintNow, 220);
    }
    setTimeout(uiStep, 80);
  });
}

var KO_RE = /[가-힣]/;
var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, CODE: 1 };

/* 화면에 있는 한국어 글자를 모아 바꿔 넣는다 */
function uiPaintNow() {
  var lang = uiLang();
  if (lang === "ko") return;
  var c = uiCache(lang), miss = [];
  var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue || !KO_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      var pn = n.parentNode;
      if (!pn || SKIP_TAGS[pn.nodeName]) return NodeFilter.FILTER_REJECT;
      if (pn.closest && pn.closest("[data-pt2-noui]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var n, list = [];
  while ((n = walk.nextNode())) list.push(n);
  list.forEach(function (node) {
    var raw = node.__ko || node.nodeValue;
    var key = raw.trim();
    if (!key) return;
    node.__ko = raw;                       /* 원문을 붙들어 둔다 (언어를 되돌릴 때 쓴다) */
    if (c[key]) { node.nodeValue = raw.replace(key, c[key]); return; }
    if (!uiSeen[lang + "|" + key]) { uiSeen[lang + "|" + key] = 1; miss.push(key); }
  });
  /* 입력칸 안내문도 같이 */
  [].forEach.call(document.querySelectorAll("input[placeholder],textarea[placeholder]"), function (el) {
    var raw = el.__ko || el.getAttribute("placeholder") || "";
    if (!KO_RE.test(raw)) return;
    el.__ko = raw;
    if (c[raw]) { el.setAttribute("placeholder", c[raw]); return; }
    if (!uiSeen[lang + "|" + raw]) { uiSeen[lang + "|" + raw] = 1; miss.push(raw); }
  });

  miss.slice(0, 60).forEach(function (t) { uiQ.push({ t: t, l: lang }); });
  if (miss.length && !uiBusy) uiStep();
}

/* 화면이 새로 그려질 때마다 다시 훑는다 */
var uiObs = null, uiTimer = null;
function uiWatch() {
  if (uiLang() === "ko") return;
  if (uiObs) return;
  try {
    uiObs = new MutationObserver(function () {
      if (uiTimer) clearTimeout(uiTimer);
      uiTimer = setTimeout(uiPaintNow, 160);
    });
    uiObs.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  uiPaintNow();
}
function uiSetLang(v) {
  LSS("pt2_ui", v);
  uiSeen = {};
  if (uiObs) { try { uiObs.disconnect(); } catch (e) {} uiObs = null; }
  /* 한국어로 되돌릴 때는 새로 고쳐 원문을 되살린다 */
  if (uiLang() === "ko") { location.reload(); return; }
  uiWatch();
}

/* ══════════════ 전화번호 명부 (카톡식 초대의 뿌리) ══════════════
   카톡은 주소록을 통째로 서버에 올려서 "이 번호는 가입자"를 가려낸다.
   웹은 주소록 전체를 못 읽으므로, 사용자가 고른 번호만 그때그때 확인한다.

   번호를 날것으로 서버에 보내지 않는다. 폰에서 해시로 바꿔 보내고
   서버는 해시끼리만 맞춰본다. 명부가 새도 번호가 새지 않는다.
   ────────────────────────────────────────────────────────────── */
function normPhone(x) {
  var d = String(x || "").replace(/[^0-9+]/g, "");
  if (d.indexOf("+") === 0) return d;
  d = d.replace(/[^0-9]/g, "");
  if (d.indexOf("82") === 0 && d.length >= 11) return "+" + d;
  if (d.indexOf("0") === 0) return "+82" + d.slice(1);      /* 010… → +8210… */
  return d ? "+" + d : "";
}
function sha256hex(txt) {
  try {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve("");
    var b = new TextEncoder().encode(txt);
    return crypto.subtle.digest("SHA-256", b).then(function (buf) {
      return [].map.call(new Uint8Array(buf), function (v) {
        return ("0" + v.toString(16)).slice(-2);
      }).join("");
    });
  } catch (e) { return Promise.resolve(""); }
}
function myPhoneHash() { return LS("pt2_ph") || ""; }

/* 내 번호를 명부에 올린다. 이걸 해둔 사람만 남이 연락처에서 찾을 수 있다 */
function registerPhone(raw, cb) {
  var n = normPhone(raw);
  if (!n || n.length < 8) { say("전화번호를 다시 확인해 주세요"); if (cb) cb(false); return; }
  sha256hex(n).then(function (h) {
    if (!h) { say("이 브라우저에서는 번호 등록을 쓸 수 없어요"); if (cb) cb(false); return; }
    api("/talk/contacts/register", { body: { uid: myUid(), nick: myNick(), hash: h } })
      .then(function (d) {
        if (d && d.ok) { LSS("pt2_ph", h); LSS("pt2_ph_show", n); say("번호를 등록했어요 📇"); if (cb) cb(true); }
        else { say((d && d.error) || "등록하지 못했어요"); if (cb) cb(false); }
      });
  });
}

/* 고른 연락처 중 누가 포도톡 사용자인지 서버에 물어본다.
   서버에 기능이 없으면(404) 조용히 전부 '미가입'으로 본다. */
function matchContacts(list, cb) {
  var jobs = list.map(function (c) {
    return sha256hex(normPhone(c.tel)).then(function (h) { c.hash = h; return c; });
  });
  Promise.all(jobs).then(function (arr) {
    var hs = arr.map(function (c) { return c.hash; }).filter(Boolean);
    if (!hs.length) { cb(arr); return; }
    api("/talk/contacts/match", { body: { hashes: hs } }).then(function (d) {
      var m = (d && d.ok && d.matches) ? d.matches : {};
      arr.forEach(function (c) {
        var hit = c.hash && m[c.hash];
        if (hit) { c.uid = hit.uid || ""; c.nick = hit.nick || ""; }
      });
      cb(arr);
    });
  });
}

/* 참여자 한 줄. 프로필 사진은 각자 자기 폰에만 있고 서버로 오지 않는다.
   그래서 나는 내 사진, 남은 이름 첫 글자를 딴 동그라미로 보여준다. */
/* 프로필 편집 — 설정 전체가 아니라 사진·이모지·닉네임까지만.
   설정 화면 전부를 열면 알림이며 키며 다 딸려 나와서 정작 고칠 것을 찾기 힘들다. */
var PROF_EMOJI = ["😀", "😎", "🧑", "👩", "👨", "🌸", "⭐", "🍑", "🧑‍🍳", "🌷"];

function renderProfile() {
  var av = "";
  try { av = window.talkAvatar ? window.talkAvatar() : ""; } catch (e) {}
  var isPh = false;
  try { isPh = !!(window.isPhoto && window.isPhoto(av)); } catch (e) {}
  var face = isPh ? imgAv(av) : '<span style="font-size:34px">' + esc(av || "😀") + "</span>";
  var row = PROF_EMOJI.map(function (x) {
    return '<button class="tk-emo' + (x === av ? " on" : "") + '" data-action="talk-set-emoji" data-e="' + x + '">' + x + "</button>";
  }).join("");

  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead"><span class="tk-back" data-pt2="prof-back">‹</span>' +
      '<div class="tk-rh-mid"><div class="tk-hi">프로필 편집</div>' +
      '<div class="tk-hs">사진 · 이모지 · 대화명</div></div></div>' +
    '<div class="tk-set">' +
      '<div class="tk-prof">' +
        '<div class="tk-prof-av">' + face + "</div>" +
        '<div class="tk-prof-mid"><div class="tk-prof-nm">' + esc(myNick()) + '</div>' +
          '<div class="tk-prof-sub">내 프로필</div></div>' +
        '<button class="tk-prof-btn" data-action="talk-pick-photo">사진 변경</button>' +
      "</div>" +
      '<input id="tkAvatarFile" type="file" accept="image/*" style="display:none">' +
      '<div class="tk-field"><label>프로필 이모지</label><div class="tk-emos">' + row + "</div></div>" +
      '<div class="tk-field"><label>내 대화명(닉네임)</label>' +
        '<input id="tkNick" value="' + esc(myNick()) + '" placeholder="포도" autocomplete="off"></div>' +
      '<button class="cta grape" data-action="talk-save-nick">닉네임 저장</button>' +
      '<div class="pt2-sub" style="margin-top:10px">사진과 대화명은 이 기기에 저장돼요. 대화방에서는 대화명이 상대에게 보입니다.</div>' +
    "</div>";
  markTab("settings");

  /* 사진 고르기는 index.html 의 처리를 그대로 쓴다 */
  var fi = document.getElementById("tkAvatarFile");
  if (fi) fi.addEventListener("change", function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f || !window.tkResizeImg) return;
    window.tkResizeImg(f, 180, function (durl) {
      try { window.DB.set("pododa_talk_avatar", durl); } catch (e2) {}
      say("프로필 사진을 바꿨어요 📷");
      avPush();
      renderProfile();
    });
  });
}

/* ══════════════ 프로필 사진 나눠 갖기 ══════════════
   내 사진은 서버에 한 번 올려두고, 남의 사진은 받아서 잠깐 들고 있는다.
   올릴 때는 112px 로 한 번 더 줄인다. 목록에 30px 로 보일 그림에 큰 파일을
   주고받을 이유가 없다. ────────────────────────────────────────── */
var avCache = {};          /* uid → 사진. 이 화면에서만 쓰고 새로고침하면 비워진다 */
var avAsked = {};

/* 내 사진을 작게 줄여 올린다. 바뀌었을 때만 한 번 */
function avShrink(durl, cb) {
  try {
    var im = new Image();
    im.onload = function () {
      try {
        var n = 112, c = document.createElement("canvas");
        c.width = n; c.height = n;
        var g = c.getContext("2d");
        var side = Math.min(im.width, im.height);
        g.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, n, n);
        cb(c.toDataURL("image/jpeg", 0.72));
      } catch (e) { cb(durl); }
    };
    im.onerror = function () { cb(""); };
    im.src = durl;
  } catch (e) { cb(""); }
}

function avPush() {
  if (!on()) return;
  var mine = myPhoto();
  var mark = mine ? hash36(mine) : "none";
  if (LS("pt2_av_sent") === mark) return;      /* 안 바뀌었으면 그냥 둔다 */
  if (!mine) {
    api("/talk/avatar", { body: { uid: myUid(), data: "" } })
      .then(function () { LSS("pt2_av_sent", mark); });
    return;
  }
  avShrink(mine, function (small) {
    if (!small) return;
    api("/talk/avatar", { body: { uid: myUid(), data: small } }).then(function (d) {
      if (d && d.ok) { LSS("pt2_av_sent", mark); avCache[myUid()] = small; }
    });
  });
}

/* 남의 사진을 받아온다. 한 번 받은 사람은 다시 묻지 않는다. */
function avFetch(uids, cb) {
  var need = uids.filter(function (u) { return u && !avCache[u] && !avAsked[u]; });
  if (!need.length) { cb && cb(); return; }
  need.forEach(function (u) { avAsked[u] = 1; });
  api("/talk/avatars?uids=" + encodeURIComponent(need.join(","))).then(function (d) {
    if (d && d.ok && d.avatars) {
      Object.keys(d.avatars).forEach(function (u) { avCache[u] = d.avatars[u]; });
    }
    cb && cb();
  });
}

/* 이 사람 얼굴 — 내 것은 내 폰 사진, 남은 받아둔 사진, 없으면 이름 첫 글자 */
function faceOf(uid, nick) {
  if (uid && uid === myUid() && myPhoto()) return imgAv(myPhoto());
  if (uid && avCache[uid]) return imgAv(avCache[uid]);
  return '<span class="pt2-mem-ini">' + esc(String(nick || "?").slice(0, 1)) + "</span>";
}

function memRow(m) {
  var me = m.uid && m.uid === myUid();
  var nm = m.nick || "익명";
  var face = faceOf(m.uid, nm);
  return '<div class="pt2-mem-row" data-pt2="mem-open"' +
      ' data-nick="' + esc(nm) + '" data-uid="' + esc(m.uid || "") + '"' +
      ' data-owner="' + (m.owner ? 1 : 0) + '" data-joined="' + (m.joined || "") + '">' +
    '<span class="pt2-mem-av">' + face + "</span>" +
    '<span class="pt2-mem-nm">' + esc(nm) + (me ? " (나)" : "") + "</span>" +
    (m.owner ? '<span class="pt2-mem-tag">방장</span>' : "") +
    '<span class="pt2-mem-go">›</span>' +
    "</div>";
}

/* 서버에 참여자 목록 기능이 아직 없으면(404) 방장 한 줄만 그대로 남는다 */
function loadMembers(sid) {
  api("/talk/room/members?room_id=" + encodeURIComponent(sid)).then(function (d) {
    if (!d || !d.ok || !d.members || !d.members.length) return;
    var box = document.getElementById("pt2Mem");
    var cnt = document.getElementById("pt2MemN");
    if (box) box.innerHTML = d.members.map(memRow).join("");
    if (cnt) cnt.textContent = "(" + d.members.length + ")";
    /* 얼굴이 도착하면 그 줄만 다시 그린다 */
    avFetch(d.members.map(function (m) { return m.uid; }), function () {
      var b2 = document.getElementById("pt2Mem");
      if (b2) b2.innerHTML = d.members.map(memRow).join("");
    });
  });
}

/* 참여자를 누르면 뜨는 프로필.
   서버가 갖고 있는 건 이름·들어온 때·방장 여부뿐이다. 사진은 각자 폰에만
   있어서, 내 것 말고는 보여줄 수가 없다. 없는 걸 있는 척하지 않는다. */
function memSheet(m) {
  var me = m.uid && m.uid === myUid();
  var nm = m.nick || "익명";
  var face = (me && myPhoto()) ? imgAv(myPhoto())
    : (m.uid && avCache[m.uid] ? imgAv(avCache[m.uid])
      : '<span class="pt2-mem-ini" style="font-size:30px">' + esc(nm.slice(0, 1)) + "</span>");
  var when = "";
  if (m.joined) {
    var t = new Date(parseInt(m.joined, 10));
    if (!isNaN(t.getTime())) {
      when = t.getFullYear() + "년 " + (t.getMonth() + 1) + "월 " + t.getDate() + "일부터";
    }
  }
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop" style="text-align:center">' +
    '<div class="pt2-prof-av">' + face + "</div>" +
    '<h3 style="margin:10px 0 2px">' + esc(nm) + (me ? " (나)" : "") + "</h3>" +
    '<div class="sd" style="text-align:center">' +
      (m.owner === "1" || m.owner === 1 ? "이 방을 만든 사람" : "참여자") +
      (when ? "<br>" + when : "") + "</div>" +
    (me
      ? '<button class="cta grape" data-pt2="prof-open">내 프로필 바꾸기</button>'
      : '<div class="pt2-sub">사진과 이름은 본인만 바꿀 수 있어요.</div>') +
    '<button class="cta" style="margin-top:10px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
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
    '<div class="sd">초대 코드 <b>' + esc(r.code || "-") + "</b> · " + (r.members || 1) + "명 참여 중" +
      (r.owner_nick ? "<br>만든 사람 · <b>" + esc(r.owner_nick) + "</b>" + (owner ? " (나)" : "") : "") + "</div>" +
    '<button class="cta grape" data-pt2="inv-open">👥 친구 초대</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="rename" data-id="' + esc(id) + '">✏️ 방 이름 바꾸기</button>' +
    '<div class="tk-toggle" style="margin-top:10px">🔔 이 방 알림<span class="tk-sw' + (muted(bare(id)) ? "" : " on") + '" data-pt2="noti-toggle" data-id="' + esc(id) + '"></span></div>' +
    /* 자동번역은 통역방·여러 나라 사람이 섞인 그룹방에서 쓰는 기능이다.
       1:1 설정에까지 얹으면 화면만 길어지고 무슨 방인지 헷갈린다. */
    /* 자동번역과 내 언어는 통역방에서 쓰는 것이다. 일반 채팅방·오픈채팅
       설정에까지 얹으면 화면만 길어지고 무슨 방인지 헷갈린다. */
    (!isLive(bare(id)) ? "" :
      '<div class="tk-toggle" style="margin-top:10px">🌐 자동번역<span class="tk-sw' + (trOn(id) ? " on" : "") + '" data-pt2="tr-toggle" data-id="' + esc(id) + '"></span></div>' +
      '<div class="pt2-sub" style="margin-top:6px">켜면 <b>남이 쓴 글</b>이 내 언어로 번역돼 보여요. 원문은 아래에 작게 남습니다. 상대도 각자 자기 언어를 고르면 서로 그냥 자기 말로 쓰면 됩니다.</div>' +
      '<div class="tk-field" style="margin-top:8px"><label>내 언어</label>' +
        '<select class="pt2-langsel" data-pt2-lang="1">' + trxOpts(myLang()) + '</select></div>') +
    (r.type === "study" ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="tasks">✓ 과제 보기</button>' : "") +
    (owner && STEP >= 5 ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="new-agent">🤖 이 방 전용 봇 만들기</button>' : "") +
    (!owner && STEP >= 5 ? '<div class="pt2-sub" style="margin-top:8px">방 전용 봇은 이 방을 만든 기기에서만 추가할 수 있어요.</div>' : "") +
    /* 나가기와 삭제를 나란히 두면 뭘 눌러야 할지 헷갈린다.
       방을 만든 사람에게는 삭제 하나만, 나머지에게는 나가기 하나만 보여준다. */
    (owner
      ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--order);border:1.5px solid var(--order);box-shadow:none" data-pt2="del-room">🗑 방 삭제하기</button>' +
        '<div class="pt2-sub" style="margin-top:6px">내가 만든 방이라, 지우면 참여한 모든 사람에게서 사라져요.</div>'
      : '<button class="cta" style="margin-top:8px;background:#fff;color:var(--order);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="leave">🚪 방 나가기</button>' +
        '<div class="pt2-sub" style="margin-top:6px">내 목록에서만 사라져요. 남은 사람들은 그대로 대화합니다.</div>') +
    /* 참여자 목록은 맨 아래에 둔다. 위에 있으면 사람이 늘어날수록
       정작 자주 쓰는 버튼들이 아래로 밀려 내려간다. */
    '<div class="tk-sec" style="margin-top:16px;display:flex;align-items:center;justify-content:space-between">' +
      '<span>참여자 <span id="pt2MemN">(' + (r.members || 1) + ')</span></span>' +
      '<button class="pt2-prof-edit" data-pt2="prof-open">✏️ 프로필 편집</button>' +
    "</div>" +
    '<div class="pt2-mem" id="pt2Mem">' + memRow({ nick: r.owner_nick || myNick(), owner: 1, uid: r.owner_uid || (owner ? myUid() : "") }) + "</div>" +
    '<button class="cta" style="margin-top:14px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
  bg.setAttribute("data-room", id);
  try { loadMembers(bare(id)); } catch (e) {}
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
      '<button class="tk-tool primary" data-pt2="ntype" data-v="general">👥 일반</button>' +
      '<button class="tk-tool" data-pt2="ntype" data-v="study">📚 스터디</button>' +
      '<button class="tk-tool" data-pt2="ntype" data-v="creator">✨ 크리에이터</button>' +
    "</div>" +
    /* 1:1 은 둘만 쓰는 방이라 코드를 따로 걸 이유가 없다.
       초대 링크를 받은 사람이 곧바로 들어오는 게 맞다. */
    '<div id="pt2NPrivBox"><div class="tk-toggle">코드로만 입장<span class="tk-sw" id="pt2NPriv" data-pt2="npriv"></span></div></div>' +
    '<div class="pt2-sub" id="pt2NDirect" style="display:none;margin-top:6px">1:1 방은 입장 코드가 없어요. 초대 링크를 받은 사람이 바로 들어옵니다.</div>' +
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


/* ══════════════ 목록에서 바로 여는 방 메뉴 ══════════════
   채팅·오픈채팅·상점톡·통역방 어디서든 방 오른쪽 ⋮ 를 누르면
   알림 끄기와 삭제를 할 수 있다. 삭제는 두 가지로 나눈다.
     · 나에게서 삭제 — 내 목록에서만 사라진다 (남은 사람은 그대로 대화)
     · 모두에게서 삭제 — 서버에서 방을 없앤다 (내가 만든 방만) */
function decorateList(){
  var box = document.getElementById("tkList");
  if (!box) return;
  var rows = box.querySelectorAll(".tk-room[data-id]");
  for (var i = 0; i < rows.length; i++) {
    var el = rows[i];
    if (el.parentNode && el.parentNode.className === "pt2-lrow") continue;
    var id = el.getAttribute("data-id") || "";
    if (id === "podo_bot") continue;                 /* 비서 방은 지우지 않는다 */
    var wrap = document.createElement("div");
    wrap.className = "pt2-lrow";
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    var b = document.createElement("button");
    b.className = "pt2-x";
    b.setAttribute("data-pt2", "rowmenu");
    b.setAttribute("data-id", id);
    b.textContent = "\u22EE";
    wrap.appendChild(b);
  }
}
function svRoomOf(sid){
  var hit = null;
  svRooms().forEach(function (r) { if (r.id === sid) hit = r; });
  return hit;
}
function repaintList(){
  var h = location.hash || "";
  if (h.indexOf("#/talk/trans") === 0) { return lseg() === "trx" ? trxList() : renderLive(lseg()); }
  if (h.indexOf("#/talk/direct") === 0) { if (on()) renderDirect(); else window.renderTalkList("direct"); return; }
  if (h.indexOf("#/talk/open") === 0 || h === "#/talk") { renderOpen(); return; }
}
function rowMenu(id){
  var sv = isSv(id), sid = sv ? bare(id) : "";
  var r = sv ? null : (function () { try { return findRoom(id); } catch (e) { return null; } })();
  var sr = sv ? svRoomOf(sid) : null;
  if (!sv && !r) return;
  var name = sv ? roomLabel(sid, sr ? sr.name : "") : r.name;
  var notiOn = sv ? !muted(sid) : (r.noti !== false);
  var owner = sv ? !!tokenOf(sid) : !!r.owner;

  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>" + esc(name) + "</h3>" +
    '<div class="sd">' + (sv ? "다른 기기·다른 사람과 함께 쓰는 방이에요" : "옮기기 전이라 이 폰에만 남아 있는 방이에요") + "</div>" +
    '<div class="tk-toggle">🔔 알림 받기<span class="tk-sw' + (notiOn ? " on" : "") + '" data-pt2="row-noti" data-id="' + esc(id) + '"></span></div>' +
    (!sv ? '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="row-pin" data-id="' + esc(id) + '">' + (r.pinned ? "📌 고정 해제" : "📌 맨 위 고정") + "</button>" : "") +
    /* 버튼은 하나만. 방을 만든 사람이면 삭제, 아니면 나가기다. */
    (sv && owner
      ? '<button class="cta" style="margin-top:10px;background:#fff;color:#c2410c;border:1.5px solid #c2410c;box-shadow:none" data-pt2="row-delall" data-id="' + esc(id) + '">🗑 방 삭제</button>' +
        '<div class="pt2-sub" style="margin-top:6px">내가 만든 방이라, 지우면 참여한 모든 사람에게서 사라져요.</div>'
      : '<button class="cta" style="margin-top:10px;background:#fff;color:var(--order);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="row-delme" data-id="' + esc(id) + '">🚪 방 나가기</button>' +
        '<div class="pt2-sub" style="margin-top:6px">내 목록에서만 사라져요.' + (sv ? " 남은 사람들은 그대로 대화합니다." : "") + "</div>") +
    '<button class="cta" style="margin-top:12px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
  "</div>";
  document.body.appendChild(bg);
}
function forgetLocalRoom(id){
  try {
    saveTalkRooms(talkRooms().filter(function (x) { return x.id !== id; }));
    DB.set("pododa_talk_msg_" + id, "");
  } catch (e) {}
}
function forgetDirect(sid){
  try { var m = LSJ("pt2_direct", {}); delete m[sid]; LSS("pt2_direct", JSON.stringify(m)); } catch (e) {}
}
function forgetSvRoom(sid){
  saveSvRooms(svRooms().filter(function (r) { return r.id !== sid; }));
  if (isLive(sid)) liveForget(sid);
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

  /* 캐시 불일치 경고에서 누르는 버튼.
     서비스워커 캐시를 비우고, 주소에 시각을 붙여 서버에서 새로 받는다. */
  if (a === "hardreload") {
    var go = function () {
      var u = location.href.split("#")[0].split("?")[0];
      location.replace(u + "?nocache=" + Date.now() + (location.hash || ""));
    };
    try {
      if (window.caches && caches.keys) {
        caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        }).then(go, go);
      } else go();
    } catch (e) { go(); }
    return;
  }

  /* 탭 · 칸 나누기 */
  if (a === "seg") {
    LSS("pt2_seg", el.getAttribute("data-v") === "pub" ? "pub" : "gen");
    renderOpen();
    if (on()) refreshRooms(function () {
      if (location.hash.indexOf("#/talk/open") === 0 || location.hash === "#/talk") renderOpen();
    });
    return;
  }
  if (a === "lang") {
    /* 하단 통역톡을 누르면 1:1 칸부터 보여준다.
       단, 통역방에서 나오는 길이면 그 방이 있던 칸으로 돌려보낸다. */
    var lk = el.getAttribute("data-k");
    LSS("pt2_lseg", lk === "multi" ? "multi" : "one");
    if (location.hash === "#/talk/trans") { try { renderTalk("trans", null); } catch (_e) {} }
    else location.hash = "#/talk/trans";
    return;
  }
  if (a === "lseg") {
    LSS("pt2_lseg", el.getAttribute("data-v"));
    if (location.hash === "#/talk/trans") { try { renderTalk("trans", null); } catch (_e) {} }
    else location.hash = "#/talk/trans";
    return;
  }
  if (a === "live-new") { newScreen(el.getAttribute("data-m") === "multi" ? "livemulti" : "live1"); return; }
  if (a === "rowmenu") { rowMenu(el.getAttribute("data-id")); return; }
  if (a === "row-noti") {
    var nid = el.getAttribute("data-id");
    if (isSv(nid)) {
      var nm = !muted(bare(nid)); setMuted(bare(nid), nm);
      el.className = "tk-sw" + (nm ? "" : " on");
      say(nm ? "알림을 껐어요 🔕" : "알림을 켰어요 🔔");
    } else {
      try { updateRoom(nid, function (r) { r.noti = (r.noti === false); }); } catch (e) {}
      var rr = null; try { rr = findRoom(nid); } catch (e) {}
      el.className = "tk-sw" + (rr && rr.noti === false ? "" : " on");
      say(rr && rr.noti === false ? "알림을 껐어요 🔕" : "알림을 켰어요 🔔");
    }
    return;
  }
  if (a === "row-pin") {
    var pid = el.getAttribute("data-id");
    try { updateRoom(pid, function (r) { r.pinned = !r.pinned; }); } catch (e) {}
    var sbp = document.querySelector(".sheet-bg"); if (sbp) sbp.remove();
    repaintList(); return;
  }
  if (a === "row-delme") {
    var mid = el.getAttribute("data-id");
    if (!confirm("내 목록에서 지울까요?\n" + (isSv(mid) ? "남은 사람들은 그대로 대화합니다." : "이 기기의 대화 내용도 함께 지워집니다."))) return;
    var sbm = document.querySelector(".sheet-bg"); if (sbm) sbm.remove();
    if (isSv(mid)) {
      var s1 = bare(mid);
      var fin1 = function () { forgetSvRoom(s1); forgetDirect(s1); repaintList(); say("내 목록에서 지웠어요"); };
      api("/talk/room/leave", { body: { room_id: s1, uid: myUid() } }).then(fin1, fin1);
    } else {
      forgetLocalRoom(mid); repaintList(); say("지웠어요");
    }
    return;
  }
  if (a === "row-delall") {
    var aid = bare(el.getAttribute("data-id"));
    if (!confirm("모두에게서 삭제할까요?\n참여한 모든 사람에게서 방과 대화가 사라집니다.")) return;
    var sba = document.querySelector(".sheet-bg"); if (sba) sba.remove();
    var fin2 = function () { forgetSvRoom(aid); forgetDirect(aid); repaintList(); refreshRooms(); say("모두에게서 삭제했어요"); };
    api("/talk/room/delete", { body: { room_id: aid }, token: tokenOf(aid) }).then(function (d) {
      if (d && !d.ok) say(d.error || "서버에서 지우지 못했어요");
      fin2();
    }, fin2);
    return;
  }
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
  if (a === "new-sv")   { newScreen(seg() === "pub" ? "open" : "group"); return; }
  if (a === "ntype")    {
    window._pt2New = window._pt2New || {};
    var nv = el.getAttribute("data-v");
    window._pt2New.type = nv;
    var box = document.getElementById("pt2NType");
    if (box) [].forEach.call(box.children, function (b) { b.className = "tk-tool" + (b === el ? " primary" : ""); });
    var pbx = document.getElementById("pt2NPrivBox");
    var dtx = document.getElementById("pt2NDirect");
    if (pbx) pbx.style.display = (nv === "direct") ? "none" : "";
    if (dtx) dtx.style.display = (nv === "direct") ? "" : "none";
    if (nv === "direct") {
      window._pt2New.priv = false;
      var swp = document.getElementById("pt2NPriv");
      if (swp) swp.className = "tk-sw";
    }
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
    var isDirect = cfg.type === "direct";
    /* 서버가 모르는 종류를 보내면 거절당할 수 있어서, 1:1 도 서버에는 general 로 만든다.
       1:1 이라는 사실은 이 기기에만 표시로 남긴다. */
    var sendType = isDirect ? "general" : cfg.type;
    api("/talk/room/create", { body: {
      name: nm,
      intro: ((document.getElementById("pt2NIntro") || {}).value || "").trim(),
      type: sendType, uid: myUid(), nick: myNick(),
      is_private: (isDirect ? 1 : (cfg.priv ? 1 : 0)),
      emoji: isDirect ? "💬" : (({ general: "🍇", study: "📚", creator: "✨" })[cfg.type] || "🍇")
    }}).then(function (d) {
      if (!d.ok) { say(d.error || "방을 만들지 못했어요"); return; }
      saveToken(d.id, d.token);
      if (isDirect) { try { var dm = LSJ("pt2_direct", {}); dm[d.id] = 1; LSS("pt2_direct", JSON.stringify(dm)); } catch (_e) {} }
      var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
      say(isDirect ? "1:1 방을 만들었어요 💬" : "방을 만들었어요 🍇");
      refreshRooms();
      /* 만들자마자 초대할 수 있게 초대 시트를 바로 띄운다 */
      setTimeout(function () { inviteSheet(d.id, d.code || "", nm); }, 350);
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
  if (a === "diag") {
    var out = document.getElementById("pt2Diag");
    var w = function (t) { if (out) out.textContent = t; };
    var base = apiBase();
    var lines = ["주소 · " + base,
                 "인터넷 · " + ((navigator.onLine === false) ? "끊김 ❌" : "연결됨 ✅"),
                 "확인하는 중…"];
    w(lines.join("\n"));

    /* ① 그냥 열어보기 (CORS 검사 없음) */
    fetch(base + "/health", { mode: "no-cors" }).then(function () {
      lines[2] = "서버까지 닿음 ✅";
    })["catch"](function (e) {
      lines[2] = "서버까지 못 닿음 ❌ (" + (e && e.message ? e.message : "원인 불명") + ")";
    }).then(function () {
      /* ② 앱이 쓰는 방식 그대로 (CORS 검사 포함) */
      w(lines.join("\n") + "\n앱 방식으로 확인 중…");
      return fetch(base + "/health", { headers: { "Content-Type": "application/json" } })
        .then(function (r) { return r.text().then(function (t) {
          lines[3] = "앱 방식 · " + r.status + " " + (t.indexOf('"ok":true') >= 0 ? "정상 ✅" : "응답 이상 ⚠️");
        }); })
        ["catch"](function (e2) {
          lines[3] = "앱 방식 · 막힘 ❌\n같은 주소를 브라우저로 열면 되는데 앱에서만 막히면 CORS 설정(ALLOW_ORIGIN)이 지금 주소와 다른 경우입니다.\n지금 주소 · " + location.origin +
            "\n(" + (e2 && e2.message ? e2.message : "원인 불명") + ")";
        });
    }).then(function () { w(lines.join("\n")); });
    return;
  }
  if (a === "g-in")  { gLogin(); return; }
  if (a === "g-out") { gLogout(); return; }
  if (a === "ui-lang") {
    uiSetLang(el.getAttribute("data-v"));
    try { renderTalkSettings(); } catch (e) {}
    say("화면 언어를 바꿨어요 🌐");
    return;
  }
  if (a === "ph-save") {
    var pv = ((document.getElementById("pt2Phone") || {}).value || "").trim();
    registerPhone(pv, function (ok2) { if (ok2) try { renderTalkSettings(); } catch (e) {} });
    return;
  }
  if (a === "ph-del") {
    if (!confirm("번호 등록을 지울까요?\n다른 사람이 연락처에서 나를 찾을 수 없게 됩니다.")) return;
    var h0 = myPhoneHash();
    var done0 = function () {
      try { localStorage.removeItem("pt2_ph"); localStorage.removeItem("pt2_ph_show"); } catch (e) {}
      say("지웠어요"); try { renderTalkSettings(); } catch (e) {}
    };
    api("/talk/contacts/register", { body: { uid: myUid(), hash: h0, remove: 1 } }).then(done0, done0);
    return;
  }
  if (a === "new-direct") { newScreen("direct"); return; }
  if (a === "new-back") {
    location.hash = newIsLive() ? "#/talk/trans"
      : ((NEWC.kind === "direct") ? "#/talk/direct" : "#/talk/open");
    return;
  }
  if (a === "new-pub")  { newKeep(); NEWC.pub = !NEWC.pub; renderNew(); return; }
  if (a === "new-pick") { newPick(); return; }
  if (a === "new-link") {
    newKeep();
    /* 연락처를 안 쓰는 길이라 방 이름을 자동으로 채울 곳이 없다.
       이름이 비어 있으면 만들지 말고 그 칸으로 데려간다. */
    if (!(NEWC.name || "").trim()) {
      say("방 이름을 먼저 입력해 주세요");
      var nf = document.getElementById("pt2CName");
      if (nf) { try { nf.focus(); nf.scrollIntoView({ block: "center" }); } catch (e) {} }
      return;
    }
    NEWC.picked = [];
    newGo();
    return;
  }
  if (a === "sms-one") {
    smsTo([el.getAttribute("data-num")], el.getAttribute("data-body") || "");
    el.textContent = "보냈어요";
    el.className = "pt2-sms-btn done";
    return;
  }
  if (a === "sms-go") {
    var ns = (el.getAttribute("data-nums") || "").split(",").filter(Boolean);
    smsTo(ns, inviteText(el.getAttribute("data-name"), el.getAttribute("data-id"), el.getAttribute("data-code")));
    return;
  }
  if (a === "new-go")   { newGo(); return; }
  if (a === "prof-open") {
    var sb0 = document.querySelector(".sheet-bg"); if (sb0) sb0.remove();
    location.hash = "#/talk/profile";
    return;
  }
  if (a === "prof-back") { history.back(); return; }
  if (a === "mem-open") {
    memSheet({
      nick: el.getAttribute("data-nick"), uid: el.getAttribute("data-uid"),
      owner: el.getAttribute("data-owner"), joined: el.getAttribute("data-joined")
    });
    return;
  }
  if (a === "inv-open") {
    if (!P.room) return;
    inviteSheet(bare(P.id), P.room.code || "", roomLabel(bare(P.id), P.room.name));
    return;
  }
  if (a === "inv-pick")  { pickContacts(el.getAttribute("data-id"), el.getAttribute("data-code"), el.getAttribute("data-name")); return; }
  if (a === "inv-share") { shareInvite(el.getAttribute("data-id"), el.getAttribute("data-code"), el.getAttribute("data-name")); return; }
  if (a === "inv-copy")  {
    var lk = inviteLink(el.getAttribute("data-id"), el.getAttribute("data-code"));
    try { navigator.clipboard.writeText(lk); say("초대 링크를 복사했어요 🔗"); }
    catch (e) { prompt("이 링크를 복사해서 보내세요", lk); }
    return;
  }
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
    /* 헤더의 종 버튼과 설정 시트의 스위치가 같은 동작을 공유한다.
       스위치일 때만 색을 바꾼다. 종이면 아래에서 아이콘을 갈아 끼운다. */
    if (el.classList.contains("tk-sw")) el.className = "tk-sw" + (nowMuted ? "" : " on");
    else el.textContent = nowMuted ? "🔕" : "🔔";
    var sw2 = document.querySelector('.tk-sw[data-pt2="noti-toggle"]');
    if (sw2) sw2.className = "tk-sw" + (nowMuted ? "" : " on");
    var bell = document.getElementById("pt2BellBtn");
    if (bell) bell.textContent = nowMuted ? "🔕" : "🔔";
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
    try { repaintList(); } catch (e9) {}
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
      var backTo = backList(lid);
      if (wasLive) liveForget(lid);
      say("방에서 나왔어요");
      refreshRooms();
      location.hash = backTo;
    });
    return;
  }
  if (a === "del-room") {
    if (!confirm("방과 모든 대화가 지워져요. 삭제할까요?")) return;
    var did = bare(P.id), wasLive2 = isLive(did);
    /* 어디로 돌아갈지는 지우기 전에 정해둔다. 지우고 나면 1:1 이었는지 알 수 없다. */
    var backTo2 = backList(did);
    api("/talk/room/delete", { body: { room_id: did }, token: tokenOf(did) }).then(function (d) {
      var sb5 = document.querySelector(".sheet-bg"); if (sb5) sb5.remove();
      if (wasLive2) liveForget(did);       /* 서버가 실패해도 내 목록에는 남기지 않는다 */
      forgetDirect(did);
      if (!d.ok) {
        /* 예전에는 여기서 늘 통역톡으로 튀었다. 온 곳으로 돌려보낸다. */
        say((d.error || "서버에서 지우지 못했어요") + " · 내 목록에서는 지웠어요");
        refreshRooms();
        location.hash = backTo2;
        return;
      }
      say("방을 삭제했어요");
      refreshRooms();
      location.hash = backTo2;
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

/* 초대 체크박스. label 안이라 click 으로 잡힌다 */
document.addEventListener("change", function (e) {
  var el = e.target;
  if (!el || el.getAttribute("data-pt2") !== "pick-ck") return;
  var i = parseInt(el.getAttribute("data-i"), 10);
  if (NEWC.picked[i]) NEWC.picked[i].on = !!el.checked;
  if (newIsSolo() && el.checked) {
    NEWC.picked.forEach(function (c, j) { if (j !== i) c.on = false; });
    NEWC.name = NEWC.picked[i] ? NEWC.picked[i].name : NEWC.name;
    newKeep(); renderNew();
  }
});

/* 하단 '일반채팅' 을 누르면 오픈채팅 칸이 아니라 일반채팅 칸부터 보여준다 */
document.addEventListener("click", function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action="talk-tab"][data-v="open"]') : null;
  if (!el) return;
  LSS("pt2_seg", "gen");
}, true);

/* '＋ 1:1 채팅 만들기' · '＋ 그룹방 만들기' 를 전체 화면으로 돌린다.
   index.html 의 작은 시트보다 먼저 잡아야 해서 캡처 단계로 듣는다. */
document.addEventListener("click", function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action="talk-new"]') : null;
  if (!el || !on()) return;
  e.preventDefault(); e.stopPropagation();
  newScreen(el.getAttribute("data-mode") === "direct" ? "direct" : "group");
}, true);

/* 알림을 눌러 들어온 경우: sw.js 가 보내는 room_id 를 서버 방으로 연다 */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "OPEN_ROOM" || !e.data.room_id) return;
    if (!on()) return;
    location.hash = "#/talk/room/" + PFX + e.data.room_id;
  });
}

/* 탭을 열어둔 채 몇 시간 지나면, 그 사이 새 판이 올라와도 이 탭은
   어제 화면 그대로 남는다. 다시 켜질 때 30분이 넘었으면 새로 받아온다.
   대화 중이거나 글을 쓰는 중이면 건드리지 않는다. */
(function staleGuard() {
  var born = Date.now();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - born < 30 * 60 * 1000) return;
    var box = document.getElementById("tkInput");
    if (box && (box.value || "").trim()) return;      /* 쓰던 글이 있으면 그냥 둔다 */
    if (document.querySelector(".sheet-bg")) return;  /* 설정 창이 열려 있으면 그냥 둔다 */
    born = Date.now();
    location.reload();
  });
})();

/* 내 사진이 바뀌었으면 조용히 올려둔다 */
setTimeout(function () { try { avPush(); } catch (e) {} }, 1500);

/* 화면 언어가 한국어가 아니면 처음부터 번역을 걸어둔다 */
try { uiWatch(); } catch (e) {}

/* 바로가기·북마크로 #/talk/trans 로 바로 들어온 경우.
   index.html 의 라우터는 pt2.js 보다 먼저 돌기 때문에 'trans' 를 몰라서
   기본값인 일반채팅 목록을 그려 놓는다. 여기서 한 번 다시 그려 맞춘다. */
(function bootRoute() {
  /* pt2.js 는 index.html 맨 아래에서 실린다. 그래서 주소를 직접 열거나
     새로고침해서 들어오면, index.html 이 자기 옛 화면을 이미 그려놓은 뒤에
     이 파일이 도착한다. 탭을 눌러 들어올 때만 새 화면이 나오고, 주소로
     바로 들어오면 옛 화면이 남던 이유가 이것이다.
     여기서 현재 주소를 한 번 다시 그려 어느 길로 들어와도 같게 맞춘다. */
  var h = location.hash || "";
  if (h.indexOf("#/talk") !== 0) return;
  var seg2 = h.slice(2).split("/");        /* "#/talk/room/sv_x" → talk, room, sv_x */
  var sub = seg2[1] || "";
  var arg = seg2[2] ? decodeURIComponent(seg2[2]) : null;
  try {
    if (sub) window.renderTalk(sub, arg);
    else window.renderTalkList("direct");
  } catch (e) {}
})();

/* index.html 이 먼저 그려놓은 옛 화면이 0.2~0.5초 스쳐 보이던 것을 막는다.
   index.html 이 <html> 에 pt2-boot 을 붙여 화면을 감춰두고, 여기서 다 그린
   뒤에 떼어낸다. 이 파일이 안 실려도 index.html 쪽 시간제한이 대신 떼어낸다. */
try { document.documentElement.classList.remove("pt2-boot"); } catch (e) {}

/* 켜져 있으면 목록을 미리 한 번 받아둔다 */
try { fixTabbar(); } catch (e) {}
window.addEventListener("hashchange", function () { try { fixTabbar(); } catch (e) {} });

if (STEP >= 2 && on()) { try { refreshRooms(); } catch (e) {} }

})();
