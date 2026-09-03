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

var PT2_VER = "134";
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
/* bare 는 앞머리(sv_)가 있다고 믿고 무조건 세 글자를 자른다. 목록에서 온
   방 id 는 앞머리가 없어서 앞 세 글자가 잘려나갔고, 그래서 내가 만든 방인데도
   열쇠를 못 찾아 "방을 만든 분만" 이라고 나왔다. 붙어 있을 때만 자른다. */
function rid(id)   { return isSv(id) ? bare(id) : String(id || ""); }
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
    '.pt2-seg4 button{font-size:10.5px;padding:8px 1px;line-height:1.3;white-space:normal}',
    '.pt2-callwrap{border:1.5px solid var(--tk-line);border-radius:14px;overflow:hidden;background:#fff}',
    '.pt2-callframe{width:100%;height:520px;border:0;display:block;transition:height .12s}',
    /* 여기 숫자는 처음 뜰 때만 쓰는 어림값이다. 폰마다 위 칸과 탭바 높이가
       달라서 숫자로 맞추면 어느 폰에서는 남고 어느 폰에서는 넘친다.
       그래서 아래 fitAiFrame 이 실제로 재서 탭바 바로 위까지 딱 채운다. */
    '.pt2-aiframe{width:100%;height:calc(100dvh - 138px);min-height:320px;border:0;display:block}',
    '.tk-in{width:100%;padding:13px 14px;border-radius:12px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-ink);font-size:15px;font-weight:700;font-family:inherit;outline:none;box-sizing:border-box}',
    '.tk-in:focus{border-color:var(--tk-grape)}',
    '.pt2-price{font-size:14.5px;line-height:2.1;color:var(--tk-ink);font-weight:700}',
    '.pt2-price b{font-weight:900;color:var(--tk-grape)}',
    '.pt2-price-sub{display:block;font-size:12.5px;color:var(--tk-sub);font-weight:700;margin:-4px 0 4px 10px}',
    '.pt2-note{margin-top:10px;font-size:13.5px;line-height:1.95;color:var(--tk-sub);font-weight:700}',
    '.pt2-note b{color:var(--tk-ink);font-weight:900}',
    '.pt2-pay{display:flex;gap:8px;margin-top:12px}',
    '.pt2-pay button{flex:1;padding:13px 8px;border-radius:12px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-sub);font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit;line-height:1.45}',
    '.pt2-pay button.on{border-color:var(--tk-grape);background:var(--tk-soft);color:var(--tk-grape)}',
    '.pt2-rep{margin-left:6px;border:none;background:none;color:#b9b2c9;font-size:15px;font-weight:900;line-height:1;padding:0 4px;cursor:pointer;font-family:inherit}',
    '.pt2-whys{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}',
    '.pt2-why{flex:1 1 44%;padding:11px 8px;border-radius:12px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-ink);font-size:13px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pt2-why:active{background:var(--tk-soft)}',
    '.pt2-repq{margin-top:10px;padding:10px 12px;border-radius:11px;background:var(--tk-soft);color:var(--tk-sub);font-size:12.5px;line-height:1.6;word-break:break-word}',
    '.pt2-blkrow{display:flex;align-items:center;gap:10px;padding:11px 4px;border-bottom:1px solid var(--tk-line)}',
    '.pt2-blkrow:last-child{border-bottom:0}',
    '.pt2-blkrow span b{display:block;font-size:14px;font-weight:800}',
    '.pt2-blkrow span small{display:block;font-size:11.5px;color:var(--tk-sub);font-weight:700}',
    '.pt2-blkx{margin-left:auto;padding:8px 12px;border-radius:10px;border:1.5px solid var(--tk-line);background:#fff;color:var(--tk-grape);font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit}',
    '.pt2-ban{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(58px + env(safe-area-inset-bottom));width:100%;max-width:430px;z-index:40;background:#FEE2E2;border-top:1.5px solid #FCA5A5;color:#991B1B;font-size:12.5px;font-weight:800;line-height:1.6;padding:10px 14px;text-align:center}',
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
    /* ── 전화통역 ──
       포도랑 아래쪽 차림표(통화기록 · 설정 · 마이)에 흩어져 있던 것들을
       전화통역과 관련된 것만 골라 이 한 칸에 모았다. */
    /* 약관·정책 줄과 같은 모양으로 맞춘다. 이모지 없이 왼쪽부터, 검은 글씨. */
    '<div class="tk-sec" style="margin-top:14px">크레딧</div>' +
    '<a class="pt2-legal" href="#/talk/credits" data-pt2="credits">' +
      '<span class="pt2-legal-t">크레딧 구입 · 잔액 보기</span><span class="pt2-legal-go">›</span></a>' +
    '<div class="pt2-sub" style="margin-top:8px">채팅 · 일반채팅 · 1:1 동시통역은 무료입니다. 다중 통역 · 마주보기 · 전화통역에 크레딧이 쓰입니다.</div>' +

    /* href="#" 를 쓰면 주소가 '#' 으로 바뀌면서 화면이 엉뚱한 데로 간다.
       누르는 것만 받고 주소는 건드리지 않는다. */
    '<a class="pt2-legal" href="javascript:void(0)" data-pt2="saytest">' +
      '<span class="pt2-legal-t">소리 시험 · 읽어주기가 되는지</span><span class="pt2-legal-go">›</span></a>' +

    '<div class="tk-sec" style="margin-top:14px">전화통역</div>' +
    '<a class="pt2-legal" href="#/talk/calllog/log" data-pt2="calllog" data-k="log">' +
      '<span class="pt2-legal-t">통화기록</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="#/talk/calllog/set" data-pt2="calllog" data-k="set">' +
      '<span class="pt2-legal-t">전화통역 설정 · 말투 · 용어집</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="#/talk/calllog/my" data-pt2="calllog" data-k="my">' +
      '<span class="pt2-legal-t">저장현황 · 기록 지우기</span><span class="pt2-legal-go">›</span></a>' +

    /* '서버 방 사용' 스위치와 'API 주소' 칸은 뺐다.
       스위치는 끄면 앱이 아무것도 못 하는 상태가 되어 켜둘 수밖에 없고,
       주소는 사용자가 고칠 일이 없는데 화면에 서버 주소만 드러냈다. */
    /* ── 서버 연결 확인 ──
       '연결하지 못했어요' 만으로는 폰 문제인지 서버 문제인지 알 수가 없다.
       실제 이유를 폰 화면에서 바로 보여준다. */
    '<div class="tk-sec" style="margin-top:14px">서버 연결 확인</div>' +
    '<button class="cta" style="background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="diag">지금 확인해 보기</button>' +
    '<div id="pt2Diag" class="pt2-sub" style="margin-top:8px;white-space:pre-wrap"></div>' +

    /* ── 내 계정 ── */
    '<div class="tk-sec" style="margin-top:14px">내 계정</div>' +
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
    '<div class="tk-sec" style="margin-top:14px">화면 언어</div>' +
    '<div class="pt2-sub">국가를 고르면 앱 화면이 그 나라 말로 바뀌어요. <b>자동</b>이면 폰 시간대(현재 위치)로 알아서 골라요 — 해외에 가면 그 나라 말로 자동 번역됩니다.</div>' +
    '<div class="pt2-lang" data-pt2-noui="1">' +
      UI_LANGS.map(function (x) {
        return '<button class="pt2-lchip' + (uiPick() === x[0] ? " on" : "") + '" data-pt2="ui-lang" data-v="' + x[0] + '">' +
          x[1] + " " + x[2] + "</button>";
      }).join("") +
    "</div>" +
    (uiWhere() ? '<div class="pt2-sub" style="margin-top:8px">📍 지금 위치 · <b>' + esc(uiWhere()) + "</b></div>" : "") +

    /* 내 번호를 올려두면 남이 연락처에서 나를 찾아 바로 초대할 수 있다.
       번호 자체는 서버에 가지 않는다. 폰에서 해시로 바꿔 보낸다. */
    '<div class="tk-sec" style="margin-top:14px">연락처로 찾기</div>' +
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
    '<div class="tk-sec" style="margin-top:16px">약관 및 정책</div>' +
    '<a class="pt2-legal" href="/terms.html" target="_blank" rel="noopener">' +
      '<span class="pt2-legal-t">이용약관</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="/privacy.html" target="_blank" rel="noopener">' +
      '<span class="pt2-legal-t">개인정보처리방침</span><span class="pt2-legal-go">›</span></a>' +
    /* 신고·차단도 정책에 해당하므로 개인정보처리방침 바로 아래에 둔다 */
    '<a class="pt2-legal" href="#/talk/safety" data-pt2="safety">' +
      '<span class="pt2-legal-t">신고와 안전 · 금지된 것</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="#/talk/blocked" data-pt2="blocked">' +
      '<span class="pt2-legal-t">차단한 사람</span><span class="pt2-legal-go">›</span></a>' +
    '<a class="pt2-legal" href="#/talk/quit" data-pt2="quit">' +
      '<span class="pt2-legal-t">계정 탈퇴 · 내 자료 모두 지우기</span><span class="pt2-legal-go">›</span></a>' +
    '<div class="pt2-sub" style="margin-top:8px">전화 통역은 통화를 녹음하지 않고, 기록은 이 폰 안에만 남습니다.</div>' +

    (STEP >= 6
      ? '<div class="tk-toggle" style="margin-top:10px">🔔 새 메시지 알림<span class="tk-sw" id="pt2PushSw" data-pt2="push"></span></div>' +
        '<button class="cta" style="background:#fff;color:var(--tk-sub);border:1.5px solid var(--tk-line);box-shadow:none;margin-top:8px" data-pt2="push-test">알림 테스트 보내기</button>'
      : "") +
    /* 버전 표시는 맨 아래에 둔다. 쓰는 분이 늘 볼 것은 아니고,
       문제가 생겼을 때 물어보기 위한 값이다. */
    '<div class="pt2-sub" style="margin-top:18px;text-align:center;line-height:1.7">' +
      stampHtml() +
      '<div style="margin-top:4px;color:var(--tk-sub);font-size:11.5px">' +
        '© 2026 BJ LEE · All rights reserved.</div>' +
    "</div>" +
    /* '예전 대화 옮기기' 는 뺐다. 이 폰에만 있던 옛 방은 이제 목록에도
       안 나오고, 모든 방이 처음부터 서버에 만들어진다. */
    "";
  box.appendChild(wrap);

  /* ── AI 키 칸 감추기 ──
     이제 AI 는 크레딧으로 돕니다. 키를 받는 곳은 개발자나 직접 쓰고 싶은
     분에게만 필요한데, 화면에 늘 보이면 "이걸 꼭 넣어야 하나" 하고 헷갈립니다.
     그래서 접어두고, 원하는 분만 펴서 쓰게 합니다. */
  try { hideKeys(box); } catch (e) {}

  if (STEP >= 6) paintPushSwitch();
}

function hideKeys(box) {
  if (box.querySelector("[data-pt2-keys]")) return;
  var secs = box.querySelectorAll(".tk-sec");
  var head = null;
  for (var i = 0; i < secs.length; i++) {
    if ((secs[i].textContent || "").indexOf("AI 키") >= 0) { head = secs[i]; break; }
  }
  if (!head) return;

  /* 제목 다음부터 다음 제목 전까지를 한 상자에 담아 접어둔다 */
  var hold = document.createElement("div");
  hold.setAttribute("data-pt2-keys", "1");
  hold.style.display = "none";
  var n = head.nextSibling, moved = [];
  while (n) {
    var nx = n.nextSibling;
    if (n.nodeType === 1 && n.classList && n.classList.contains("tk-sec")) break;
    if (n.nodeType === 1 && n.getAttribute && n.getAttribute("data-pt2-sec")) break;
    moved.push(n); n = nx;
  }
  if (!moved.length) return;
  head.parentNode.insertBefore(hold, moved[0]);
  moved.forEach(function (x) { hold.appendChild(x); });

  head.style.display = "none";
  var link = document.createElement("div");
  link.className = "pt2-sub";
  link.style.cssText = "margin-top:14px;text-align:center;cursor:pointer;text-decoration:underline";
  link.textContent = "고급 · 내 AI 키 직접 쓰기";
  link.addEventListener("click", function () {
    var on = hold.style.display === "none";
    hold.style.display = on ? "" : "none";
    head.style.display = on ? "" : "none";
    link.textContent = on ? "고급 설정 접기" : "고급 · 내 AI 키 직접 쓰기";
  });
  hold.parentNode.insertBefore(link, hold);
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

/* 간격을 늘렸다가 되돌렸다. 조용할 때 30초까지 느려지게 해봤는데,
   상대가 말을 걸어도 한참 뒤에야 뜨는 게 채팅 앱으로는 답답했다.
   서버 값은 줄지만 쓰는 맛을 버리면 안 된다. 3초 고정으로 되돌린다.
   요청 수를 줄이는 일은 나중에 WebSocket 으로 제대로 하는 게 맞다. */
function stopPoll() { if (P.timer) { clearInterval(P.timer); P.timer = null; } }
function startPoll() {
  stopPoll();
  if (document.hidden) return;          /* 화면을 안 보고 있으면 아예 걸지 않는다 */
  P.timer = setInterval(function () {
    if (!document.hidden && P.id) poll(false);
  }, POLL_MS);
}
/* 화면을 덮거나 다른 앱으로 넘어가면 타이머를 끊는다. 예전에는 타이머가 계속
   돌면서 매번 '숨김이니 건너뛴다' 만 했다. 요청은 안 나갔지만 타이머는 살아
   있었고, 돌아올 때까지 아무것도 못 받았다. 이제는 끊고, 돌아오면 한 번 받아
   따라잡은 뒤 다시 건다. 사람이 늘수록 이 한 가지가 서버 요청을 크게 줄인다. */
document.addEventListener("visibilitychange", function () {
  if (document.hidden) { stopPoll(); return; }
  if (P.id) { poll(false); startPoll(); }
});

/* 방을 떠나면 타이머를 끈다. router 는 등록 시점의 참조로 묶여 있어 감싸도 안 먹으므로
   hashchange 를 따로 듣는다. 새 해시가 서버 방이면 건드리지 않는다. */
window.addEventListener("hashchange", function () {
  var m = (location.hash || "").match(/#\/talk\/room\/([\w-]+)/);
  if (!m || !isSv(m[1])) { stopPoll(); pt2MicStop(); P.id = null; P.room = null; P.after = 0; P.list = []; }
});


function msgHtml(m) {
  var mine = m.uid === myUid();
  var t = "";
  try { t = tkClock(m.created); } catch (e) {}

  /* 남이 쓴 글은 자동번역을 시도한다. 원문은 아래에 작게 남긴다 */
  /* 서버가 방 안의 언어들로 미리 번역해 보내준 것(m.tr)이 있으면 그걸 쓴다.
     100명 방이어도 서버는 언어 수만큼만 번역하므로, 받는 폰은 아무것도
     요청하지 않는다. 아직 안 왔으면 예전처럼 폰이 스스로 번역한다. */
  var tr = mine ? null
    : (m.tr && trOn(P.id) ? { text: m.tr } : trFor(m.body, m.created));
  var main = (tr && tr.text) ? tr.text : m.body;
  var sub = "";
  if (tr && tr.text) sub = '<div class="pt2-orig">' + esc(m.body) + "</div>";
  else if (tr && tr.pending) sub = '<div class="pt2-orig">🌐 번역 중…</div>';
  else if (tr && tr.nocredit) sub = '<div class="pt2-orig">🔒 번역되지 않았어요 · 말한 분의 크레딧이 부족합니다</div>';

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
    '<div class="tk-bcol"><div class="tk-who">' + esc(m.nick || "익명") +
      '<button class="pt2-rep" data-pt2="rep-open" data-u="' + esc(m.uid || "") +
      '" data-n="' + esc(m.nick || "") + '" data-m="' + esc(m.id || "") +
      '" data-b="' + esc(String(m.body || "").slice(0, 300)) + '" title="신고">⋯</button></div>' +
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
function setMyLang(v){
  LSS("pt2_tr_lang", v);
  /* 서버가 방 안의 언어 목록을 알아야 미리 번역할 수 있다. 조용히 알려둔다. */
  try {
    if (P.id) api("/talk/room/join", { body: {
      room_id: bare(P.id), uid: myUid(), nick: myNick(),
      lang: trxG(v).toLowerCase()
    }});
  } catch (e) {}
}

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
  /* 우리 서버(Workers AI)로 번역한다. 예전에는 구글 무료 주소를 직접 불렀는데
     공식 API 가 아니라 사람이 늘면 막힌다. 서버가 같은 문장을 캐시로 들고
     있어서 두 번째부터는 모델을 아예 부르지 않는다.
     서버가 답을 못 주면 옛 길(구글 → 내 AI 키)로 한 번 더 시도한다. */
  api("/talk/translate", { body: { text: job.text, to: trxG(job.tgt).toLowerCase() } })
    .then(function (r) {
      if (r && r.ok && r.text) { done(r.text); return; }
      trxGoogle(job.text, "auto", trxG(job.tgt), done, function () {
        trxAI(job.text, "EN", job.tgt, function (o) { done(o); });
      });
    }, function () {
      trxGoogle(job.text, "auto", trxG(job.tgt), done, function () {
        trxAI(job.text, "EN", job.tgt, function (o) { done(o); });
      });
    });
}

/* 이 메시지를 내 언어로 바꾼 결과. 아직 없으면 줄 세우고 '번역 중'을 돌려준다 */
function trFor(text, when){
  if (!P.id || !trOn(P.id) || !text) return null;

  /* ── 다중 동시통역방(👪) ──
     이 방은 말한 사람이 크레딧을 내고, 서버가 방 안의 언어들로 미리 번역해
     메시지에 붙여 보냅니다(m.tr). 그것이 없다는 건 말한 사람에게 크레딧이
     없었다는 뜻입니다. 그때 받는 폰이 스스로 번역해 버리면 아무도 내지 않고
     쓰는 셈이 되고, 그 값(Workers AI)은 우리가 냅니다. 그래서 이 방에서는
     폰이 대신 번역하지 않습니다.
     단, 보낸 직후에는 서버가 아직 번역 중일 수 있으므로 15초는 기다립니다.
     1:1 통역방과 일반 채팅은 원래 무료라 그대로 둡니다. */
  try {
    if (P.room && P.room.emoji === "👪") {
      if (when && (Date.now() - when) < 15000) return { pending: true };
      return { nocredit: true };
    }
  } catch (e) {}

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

/* ══ 폴링 — 바뀐 것만 받아온다 ══
   예전에는 3초마다 최근 60개를 통째로 다시 받았다. 새 글이 없어도 60개였다.
   서버는 처음부터 after 커서를 받을 수 있었는데 앱이 안 보내고 있었다.
   이제 마지막으로 받은 시각을 함께 보낸다. 새 글이 없으면 0개가 온다.
   사람이 늘수록 이 한 줄이 데이터베이스 읽기를 통째로 없앤다. */
function poll(first) {
  if (!P.id) return Promise.resolve();
  var url = "/talk/messages?room_id=" + encodeURIComponent(bare(P.id)) +
            "&uid=" + encodeURIComponent(myUid()) +
            "&lang=" + encodeURIComponent(trxG(myLang()).toLowerCase());
  /* 방에 처음 들어올 때만 통째로 받고, 그 뒤로는 새 것만 받는다 */
  var inc = !first && P.after && (P.list || []).length;
  if (inc) url += "&after=" + encodeURIComponent(P.after);

  return api(url).then(function (d) {
    if (!P.id || !d || !d.messages) return;

    var list;
    if (inc) {
      if (!d.messages.length) {
        /* 새 글이 없다. 봇 기다림만 확인하고 그림은 그대로 둔다 */
        if (P.waiting && Date.now() - (P.waitSince || 0) > 90000) {
          P.waiting = false; renderMsgs(P.list || [], false);
        }
        return;
      }
      /* 이어 붙인다. 같은 글이 두 번 들어오지 않게 id 로 거른다 */
      var seen = {};
      (P.list || []).forEach(function (x) { if (x && x.id) seen[x.id] = 1; });
      list = (P.list || []).concat(d.messages.filter(function (x) { return !(x && x.id && seen[x.id]); }));
      if (list.length > 300) list = list.slice(-300);      /* 너무 길어지면 앞을 버린다 */
    } else {
      list = d.messages || [];
    }

    var last = list.length ? list[list.length - 1] : null;
    if (last && last.created) P.after = last.created;

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
  /* stop() 만 부르면 안드로이드가 엔진을 몇 백 밀리초 더 물고 있습니다.
     그동안에는 읽어주기가 synthesis-failed 로 실패합니다.
     abort() 로 확실히 끊고, 붙어 있던 손잡이도 떼어냅니다. */
  if (pt2Rec) {
    try { pt2Rec.onresult = pt2Rec.onend = pt2Rec.onerror = null; } catch (e) {}
    try { pt2Rec.abort(); } catch (e) {}
    try { pt2Rec.stop(); } catch (e) {}
  }
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
  P.id = id; P.sig = ""; P.room = null; P.bots = []; P.after = 0; P.list = [];
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
    api("/talk/room/join", { body: { room_id: bare(id), uid: myUid(), nick: myNick(), lang: trxG(myLang()).toLowerCase() } });
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
  stopPoll(); P.id = null; P.after = 0; P.list = [];
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

  /* @봇을 부를 때는 내 AI 키를 함께 보낸다. 키가 있으면 그 키로 돌아가서
     한도가 없다. 키는 서버에 저장되지 않고 그 요청에서만 쓰인다. */
  var mine = { room_id: bare(id), uid: myUid(), nick: myNick(), body: text,
               lang: trxG(myLang()).toLowerCase() };
  try {
    if (mentions.length && typeof getKey === "function" && getKey()) {
      mine.ai_key = getKey();
      mine.ai_provider = (typeof getProvider === "function" ? getProvider() : "claude");
    }
  } catch (e) {}

  api("/talk/message", { body: mine })
    .then(function (d) {
      if (!d || !d.ok) { say((d && d.error) || "전송하지 못했어요"); poll(true); return; }
      var names = (d.bots && d.bots.length) ? d.bots : mentions;
      if (STEP >= 4 && names.length) {
        P.waiting = true;
        P.waitSince = d.created || Date.now();
        P.waitNames = names.join(", @");
        chaseBot();
      }
      /* 크레딧이 바닥나면 한 번만 알려준다. 말은 막히지 않는다.
         번역만 안 될 뿐이고, 받는 쪽은 원문을 그대로 본다. */
      if (d.low && !window.__lowSaid) {
        window.__lowSaid = 1;
        setTimeout(function () {
          say("크레딧이 없어 번역이 안 돼요. 설정 → 크레딧에서 채워주세요");
        }, 600);
      }
      if (!d.low) window.__lowSaid = 0;

      P.sig = "";                    /* 강제로 다시 그리게 */
      poll(false);                   /* after 커서로 새 것만 받아 이어 붙인다 */
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
   채팅 · 일반채팅 · 통역톡 · 포도AI · 설정 (5칸)
   포도AI 는 podoya.ai.kr 로 넘어간다. 아이콘은 앱 아이콘(podotalk-192.png)을
   그대로 쓴다 — 🍇 는 채팅 목록의 포도야 비서와 겹쳐서 헷갈렸다.
   index.html 은 건드리지 않고 여기서 버튼만 다시 그린다. */
function fixTabbar() {
  var bar = document.getElementById("talkbar");
  if (!bar || bar.getAttribute("data-pt2") === "1") return;
  bar.setAttribute("data-pt2", "1");
  bar.innerHTML =
    /* 쇼핑은 포도다(pododa.kr)로 넘기는 문이었다. 포도톡에서 쇼핑까지
       하려면 아직 갈 길이 멀어서 탭에서 뺐다. 필요해지면 되살리면 된다. */
    /* 순서 : 포도AI · 채팅 · 일반채팅 · 통역톡 · 설정
       앱을 열면 포도AI 가 먼저 나오므로 탭도 맨 앞에 둔다. */
    '<button data-pt2="podoya" id="tk-tab-podoya"><span class="ti" style="display:flex;align-items:center;justify-content:center;height:22px"><img src="/podotalk-192.png" alt="" style="width:22px;height:22px;border-radius:7px;display:block;object-fit:cover"></span>포도AI</button>' +
    '<button data-action="talk-tab" data-v="direct" id="tk-tab-direct"><span class="ti">💬</span>채팅</button>' +
    '<button data-action="talk-tab" data-v="open" id="tk-tab-open"><span class="ti">👥</span>일반채팅</button>' +
    '<button data-pt2="lang" id="tk-tab-lang"><span class="ti">🌐</span>통역톡</button>' +
    '<button data-action="talk-tab" data-v="settings" id="tk-tab-settings"><span class="ti">⚙️</span>설정</button>';
}
function markTab(id) {
  fixTabbar();
  ["direct", "lang", "open", "settings", "podoya"].forEach(function (t) {
    var b = document.getElementById("tk-tab-" + t);
    if (b) b.classList.toggle("on", t === id);
  });
}


/* ══════════════ 동시통역톡 (통역톡 안의 두 번째 칸) ══════════════
   서버 방인데 자동번역이 켜진 채로 태어난다.
   각자 자기 폰에서 자기 언어만 고르면 서로 자기 말로 쓰면 된다. */
function lseg(){
  var v = LS("pt2_lseg");
  return (v === "multi" || v === "trx" || v === "call") ? v : "one";
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
  return '<div class="pt2-seg pt2-seg4">' +
    '<button class="' + (cur === "one" ? "on" : "") + '" data-pt2="lseg" data-v="one">💬 1:1<br>동시통역</button>' +
    '<button class="' + (cur === "multi" ? "on" : "") + '" data-pt2="lseg" data-v="multi">👪 다중<br>동시통역</button>' +
    '<button class="' + (cur === "trx" ? "on" : "") + '" data-pt2="lseg" data-v="trx">🔄 마주보기<br>통역</button>' +
    '<button class="' + (cur === "call" ? "on" : "") + '" data-pt2="lseg" data-v="call">📞 전화<br>통역</button>' +
  "</div>";
}

/* ══════════════ 전화통역 (통역톡 안의 네 번째 칸) ══════════════
   포도랑(podolang.kr)의 전화 통역 화면을 그대로 불러온다.
   포도랑 쪽은 주소에 ?call 이 붙으면 전화 통역 칸부터 열게 해 뒀다.
   여기서는 화면을 띄우기만 한다. 통역·통화는 전부 포도랑이 맡는다. */
/* 예전에는 '포도랑에서 바로 열기' 버튼이 있어서 여기에 주소를 두었다.
   손님이 보는 앱을 포도톡 하나로 모으면서 그 버튼을 뺐고, 주소도 함께 뺐다.
   아래 podoFrame 이 창 안에 불러오는 주소는 그대로다. 전화통역은 그대로 돈다. */

/* 포도랑 화면을 창 하나에 담아 보여준다. 안쪽 스크롤은 없다.
   포도랑이 '내 키가 이만큼' 이라고 알려주면 그만큼 창을 늘린다. */
function podoFrame(q, later){
  /* 내 번호를 함께 넘긴다. 포도랑이 이걸로 포도톡 크레딧을 확인하고 깎는다.
     이용권을 따로 사지 않아도 되게 하려고 붙였다.
     later 를 주면 주소를 src 가 아니라 data-src 에 담아 둔다. 부르는 쪽이
     replace 로 채우면 뒤로가기 기록에 한 칸이 안 쌓인다. */
  var u = "https://podolang.kr/?" + q + "&uid=" + encodeURIComponent(myUid());
  return '<div class="pt2-callwrap"><iframe class="pt2-callframe" ' +
    (later ? 'data-src="' + esc(u) + '"' : 'src="' + esc(u) + '"') + ' ' +
    'allow="microphone; autoplay; clipboard-write" scrolling="no"></iframe></div>';
}
window.addEventListener("message", function (ev) {
  try {
    if (!ev.data || ev.data.podolang !== "h") return;
    if (String(ev.origin || "").indexOf("podolang.kr") < 0) return;
    var f = document.querySelector(".pt2-callframe");
    if (f) f.style.height = Math.max(320, ev.data.h | 0) + "px";
  } catch (e) {}
});

function renderCall(){
  var head = ""; try { head = tkHeader("통역톡", "📞 전화통역"); } catch (e) {}
  document.querySelector("#view").innerHTML = head + segBarHtml("call") +
    '<div class="trx-lead">상대는 <b>그냥 전화를 받아</b> 평소처럼 말하면 됩니다. 앱을 깔 필요도, 버튼을 누를 필요도 없어요.<br>' +
    '<b>이어폰을 쓰세요.</b> 스피커로 들으면 통역 음성을 마이크가 다시 주워서 말이 꼬입니다.</div>' +
    podoFrame("call") +
    '<div class="tk-tools" style="margin-top:10px">' +
    '<div class="pt2-sub" style="text-align:center;margin:10px 0 14px">전화 통역은 포도랑 이용권이 필요합니다 · PT2 v' + PT2_VER + "</div>";
  markTab("lang");
}

/* ══════════════ 안전 · 신고 · 차단 ══════════════
   앱스토어(지침 1.2)가 사람이 글을 올리는 앱에 요구하는 것들이다.
   막는 일은 서버가 한다. 여기서는 누르는 자리와 보여주는 것만 맡는다. */
var BLK = { list: [], loaded: false };
function blkLoad(cb){
  api("/talk/blocks?uid=" + encodeURIComponent(myUid())).then(function (d) {
    BLK.list = (d && d.blocks) || []; BLK.loaded = true; if (cb) cb();
  }, function () { if (cb) cb(); });
}
function blkHas(uid){
  for (var i = 0; i < BLK.list.length; i++) if (BLK.list[i].uid === uid) return true;
  return false;
}

/* 신고 이유 고르기 */
var REP_WHY = ["욕설·괴롭힘", "음란물", "도박 권유", "마약 거래", "총기·무기", "사기·스팸", "기타"];
function repSheet(uid, nick, mid, text, roomId){
  if (!uid || uid === myUid()) { say("자기 자신은 신고할 수 없어요"); return; }
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    "<h3>🚨 신고하기</h3>" +
    '<div class="sd"><b>' + esc(nick || "이 사람") + "</b> 님을 신고합니다.<br>" +
    "신고하면 이 사람의 글은 <b>바로 안 보이게</b> 됩니다. 서로 다른 사람 3명이 신고하면 " +
    "사람 손을 거치지 않고 <b>즉시 글쓰기가 제한</b>됩니다.</div>" +
    (text ? '<div class="pt2-repq">' + esc(String(text).slice(0, 160)) + "</div>" : "") +
    '<div class="pt2-whys">' + REP_WHY.map(function (w) {
      return '<button class="pt2-why" data-pt2="rep-go" data-u="' + esc(uid) + '" data-n="' + esc(nick || "") +
        '" data-m="' + esc(mid || "") + '" data-r="' + esc(w) + '" data-rid="' + esc(roomId || "") +
        '" data-b="' + esc(String(text || "").slice(0, 300)) + '">' + esc(w) + "</button>";
    }).join("") + "</div>" +
    '<button class="cta" style="margin-top:10px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">취소</button>' +
    "</div>";
  document.body.appendChild(bg);
}
function repSend(el){
  var uid = el.getAttribute("data-u");
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  say("신고를 접수했어요");
  api("/talk/report", { body: {
    uid: myUid(), target_uid: uid, reason: el.getAttribute("data-r"),
    msg_id: el.getAttribute("data-m"), room_id: el.getAttribute("data-rid"),
    body: el.getAttribute("data-b")
  }}).then(function (d) {
    blkLoad();
    if (d && d.banned) say("신고 " + (d.reports || "") + "건이 쌓여 이 사람의 글쓰기가 제한되었어요");
    else say("접수했어요. 이 사람의 글은 이제 안 보입니다");
    P.sig = ""; poll(true);
  }, function () { say("신고를 보내지 못했어요"); });
}
function blkAdd(uid, nick){
  if (!uid || uid === myUid()) return;
  api("/talk/block", { body: { uid: myUid(), target_uid: uid } }).then(function () {
    say((nick ? nick + " 님을" : "이 사람을") + " 차단했어요");
    blkLoad(function () { P.sig = ""; poll(true); });
  }, function () { say("차단하지 못했어요"); });
}
function blkDel(uid){
  api("/talk/block", { body: { uid: myUid(), target_uid: uid, remove: 1 } }).then(function () {
    say("차단을 풀었어요");
    blkLoad(function () { renderBlocked(); });
  });
}

/* 설정 → 차단한 사람 */
function renderBlocked(){
  var head = ""; try { head = tkHeader("차단한 사람", "🛡 안전"); } catch (e) {}
  var rows = BLK.list.length
    ? BLK.list.map(function (b) {
        return '<div class="pt2-blkrow"><span class="pt2-mem-ini">' + esc((b.nick || "?").slice(0, 1)) + "</span>" +
          "<span><b>" + esc(b.nick || "이름 없음") + "</b><small>차단함</small></span>" +
          '<button class="pt2-blkx" data-pt2="blk-del" data-u="' + esc(b.uid) + '">차단 풀기</button></div>';
      }).join("")
    : '<div class="pt2-sub" style="text-align:center;padding:26px 0">차단한 사람이 없습니다.</div>';
  document.querySelector("#view").innerHTML = head +
    '<div class="pt2-sub" style="margin:-4px 0 10px">차단한 사람의 글은 보이지 않습니다. 상대는 차단된 사실을 알 수 없습니다.</div>' +
    '<div class="tk-card" style="padding:6px 10px">' + rows + "</div>";
  markTab("settings");
  /* 한 번만 받아온다. 예전에는 받아온 뒤 다시 그리고, 그리면서 또 받아와
     요청이 끝없이 되풀이됐다. */
  if (!BLK.loaded) blkLoad(function () {
    if ((location.hash || "").indexOf("#/talk/blocked") === 0) renderBlocked();
  });
}

/* 설정 → 신고 안내 */
function renderSafety(){
  var head = ""; try { head = tkHeader("신고와 안전", "🛡 안전"); } catch (e) {}
  document.querySelector("#view").innerHTML = head +
    '<div class="tk-card" style="padding:14px 15px">' +
      '<div class="pt2-sub" style="line-height:1.9">' +
        "<b>금지된 것</b><br>" +
        "· 욕설 · 괴롭힘 · 협박<br>" +
        "· 음란물, 성매매 알선<br>" +
        "· 도박 권유 · 사설 도박 광고<br>" +
        "· 마약 거래<br>· 총기 · 무기 거래<br>· 사기 · 스팸 · 사칭" +
      "</div>" +
    "</div>" +
    '<div class="tk-card" style="padding:14px 15px;margin-top:10px">' +
      '<div class="pt2-sub" style="line-height:1.9">' +
        "<b>어떻게 처리되나요</b><br>" +
        "① 마약 · 도박 · 총기 · 성매매 <b>거래 글은 아예 보내지지 않습니다.</b> 보내려 한 사람은 그 자리에서 30일 제한됩니다.<br>" +
        "② 욕설은 ●● 로 가려집니다.<br>" +
        "③ 신고하면 그 사람 글이 <b>나에게는 바로</b> 안 보입니다.<br>" +
        "④ 서로 다른 사람 <b>3명이 신고하면 7일</b>, <b>10명이면 1년</b> 글쓰기가 제한됩니다. " +
        "사람이 확인할 때까지 기다리지 않고 <b>즉시</b> 적용됩니다." +
      "</div>" +
    "</div>" +
    '<div class="pt2-sub" style="margin-top:12px;line-height:1.9">' +
      "잘못 걸렸거나 급한 일은 <b>hasin5jk@gmail.com</b> 으로 알려주세요. 확인해서 풀어드립니다." +
    "</div>" +
    '<a class="pt2-legal" style="margin-top:12px" href="#/talk/blocked" data-pt2="blocked"><span class="pt2-legal-t">차단한 사람 보기</span><span class="pt2-legal-go">›</span></a>';
  markTab("settings");
}

/* 내가 제한을 받고 있으면 위에 알려준다 */
function banCheck(){
  api("/talk/mystate?uid=" + encodeURIComponent(myUid())).then(function (d) {
    var b = d && d.ban; if (!b) return;
    var t = new Date(b.until || Date.now());
    var el = document.getElementById("pt2Ban");
    if (!el) {
      el = document.createElement("div");
      el.id = "pt2Ban"; el.className = "pt2-ban";
      document.body.appendChild(el);
    }
    el.innerHTML = "🚫 신고가 쌓여 글쓰기가 제한되었습니다 · " +
      (t.getMonth() + 1) + "월 " + t.getDate() + "일까지<br>" +
      '<span style="font-weight:700">' + esc(b.reason || "") + " · 문의 hasin5jk@gmail.com</span>";
  }, function () {});
}

/* ══════════════ 크레딧 ══════════════
   AI 는 우리 키로 돌아간다. 그래서 쓰는 만큼 크레딧이 깎인다.
   깎는 일은 전부 서버가 한다. 여기서는 보여주고 채우기만 한다. */
var CDS = { balance: null, cost: null, packs: null };
function cdLoad(cb){
  api("/talk/credits?uid=" + encodeURIComponent(myUid())).then(function (d) {
    if (d) { CDS.balance = d.balance; CDS.cost = d.cost || null; }
    if (cb) cb();
  }, function () { if (cb) cb(); });
  if (!CDS.packs) {
    api("/talk/credits/packs").then(function (d) {
      if (d && d.packs) {
        CDS.packs = d.packs;
        var pk = document.getElementById("cdPacks");
        if (pk) pk.innerHTML = cdPacksHtml();
      }
    }, function () {});
  }
}

/* 사기 — 카드 결제가 붙기 전까지 쓰는 길이다.
   누르면 주문번호가 나온다. 그 번호로 입금하면 사장님이 승인하고,
   크레딧이 앱에 바로 들어온다. 코드를 옮겨 적을 일이 없다. */
function cdBuy(pid){
  var k = null;
  (CDS.packs || []).forEach(function (x) { if (x.id === pid) k = x; });
  if (!k) return;
  say("주문서를 만드는 중…");
  api("/talk/order", { body: { uid: myUid(), pack: k.id, nick: myNick() } })
    .then(function (d) {
      if (!d || !d.ok) { say((d && d.error) || "주문하지 못했어요"); return; }
      LSS("pt2_order_no", d.no);
      cdOrderSheet(d);
    }, function () { say("주문하지 못했어요"); });
}
function cdOrderSheet(d){
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    '<h3><img src="/podotalk-192.png" alt="" style="width:22px;height:22px;border-radius:7px;vertical-align:-4px;margin-right:6px"> ' + Number(d.credits).toLocaleString() + "크레딧</h3>" +
    '<div class="sd">아래 <b>주문번호</b>를 입금자명 뒤에 붙여 보내주세요. ' +
    "확인되면 크레딧이 <b>앱에 바로 들어옵니다.</b> 코드를 옮겨 적지 않아도 됩니다.</div>" +
    '<div class="tk-card" style="padding:16px;text-align:center;margin-top:12px">' +
      '<div class="pt2-sub">주문번호</div>' +
      '<div style="font-size:30px;font-weight:900;color:var(--tk-grape);letter-spacing:2px">' +
        esc(d.no) + "</div>" +
      '<div class="pt2-sub" style="margin-top:8px">보낼 금액 <b>' +
        Number(d.krw).toLocaleString() + "원</b></div>" +
    "</div>" +
    (d.bank ? '<div class="tk-card" style="padding:14px;margin-top:10px"><div class="pt2-sub" style="line-height:1.9">' +
        esc(d.bank) + "</div></div>" : "") +
    '<button class="cta" style="margin-top:12px" data-pt2="cd-check">입금했어요 · 확인하기</button>' +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
}
/* 승인됐는지 확인 */
function cdCheck(){
  var no = LS("pt2_order_no");
  if (!no) { say("주문 내역이 없어요"); return; }
  say("확인 중…");
  api("/talk/order?no=" + encodeURIComponent(no)).then(function (d) {
    var o = d && d.order;
    if (o && o.state === "done") {
      var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
      say(Number(o.credits).toLocaleString() + "크레딧이 들어왔어요");
      CDS.balance = null; cdLoad(function () { renderCredits(); });
    } else {
      say("아직 확인 전이에요. 입금 후 조금만 기다려 주세요");
    }
  }, function () { say("확인하지 못했어요"); });
}

/* 화면을 새로 그리면 스크롤이 앞 화면 위치에 그대로 남아, 새 화면의
   한가운데나 아래쪽이 먼저 보인다. 그래서 그릴 때마다 맨 위로 올린다. */
function toTop(){
  try {
    var v = document.querySelector("#view"); if (v) v.scrollTop = 0;
    window.scrollTo(0, 0);
    [60, 200, 500].forEach(function (ms) {
      setTimeout(function () {
        var v2 = document.querySelector("#view"); if (v2) v2.scrollTop = 0;
        try { window.scrollTo(0, 0); } catch (e) {}
      }, ms);
    });
  } catch (e) {}
}

function renderCredits(){
  var head = ""; try { head = tkHeader("크레딧", '<img src="/podotalk-192.png" alt="" style="width:15px;height:15px;border-radius:5px;vertical-align:-2px;margin-right:4px">크레딧'); } catch (e) {}
  var b = CDS.balance;
  document.querySelector("#view").innerHTML = head +
    '<div class="tk-card" style="padding:18px 16px;text-align:center">' +
      '<div class="pt2-sub" style="margin-bottom:6px">남은 크레딧</div>' +
      '<div id="cdBal" style="font-size:34px;font-weight:900;color:var(--tk-grape);line-height:1.2">' +
        (b === null ? "…" : Number(b).toLocaleString()) + "</div>" +
    "</div>" +

    /* 포도AI와 지갑 합치기 — 처음 오신 분이 가장 먼저 보게 둔다 */
    '<details class="pt2-fold" style="margin-top:16px">' +
      '<summary><span style="flex:1">포도AI 연결</span><span class="fold-ar">\u25BE</span></summary>' +
      pkCardHtml() +
    "</details>" +

    /* 크레딧 사기 */
    '<div class="tk-sec" style="margin-top:16px">크레딧 사기</div>' +
    '<div class="tk-card" id="cdPacks" style="padding:6px 10px">' + cdPacksHtml() + "</div>" +
    '<div class="pt2-sub" style="margin-top:8px">1크레딧으로 번역 한 줄을 보냅니다.</div>' +

    '<div class="tk-sec" style="margin-top:16px">충전 코드로 채우기</div>' +
    '<div class="tk-card" style="padding:14px 15px">' +
      '<div style="font-size:13px;font-weight:800;margin-bottom:3px">크레딧을 사고 받은 코드</div>' +
      '<div class="pt2-sub" style="margin-bottom:11px">' +
        '<b>PODO</b> 뒤에 <b>대시 없이</b> 글자가 이어집니다</div>' +
      '<input id="cdCode" class="tk-in" placeholder="PODOABCD1234EFGH" ' +
        'style="text-transform:uppercase;letter-spacing:1px">' +
      '<button class="cta" style="margin-top:10px" data-pt2="cd-redeem">채우기</button>' +
      '<div style="margin-top:12px;border-top:1px solid rgba(0,0,0,.07);padding-top:10px">' +
        '<div class="pt2-sub" style="line-height:1.9">' +
          '<b>PODOABCD1234EFGH</b> · 대시 없음 &rarr; 여기 (크레딧이 늘어남)<br>' +
          '<b>PODO-ABCD-EFGH</b> · 대시 있음 &rarr; 위의 <b>계정 지갑</b>' +
        "</div></div>" +
    "</div>" +

    /* 내가 만든 방에 크레딧을 넣어둘 수 있다. 방 사람들이 말할 때 거기서
       빠져나간다. 사람마다 나눠줄 필요가 없고, 안 쓴 몫은 되돌려받는다. */
    (function () {
      var mine = [];
      try {
        /* 다중 동시통역방만 지갑을 둔다.
           채팅·일반채팅은 원래 공짜라 채워줄 것이 없고,
           1:1 통역·마주보기·전화통역은 개인이 쓰는 것이라 각자 낸다.
           방장이 남의 전화값까지 내주는 건 아무도 원하지 않는다. */
        mine = (svRooms() || []).filter(function (r) {
          return r && r.id && tokenOf(r.id) && liveKind(r.id) === "multi";
        });
      } catch (e) {}
      if (!mine.length) {
        return '<div class="tk-sec" style="margin-top:16px">방 지갑</div>' +
          '<div class="tk-card" style="padding:14px 15px"><div class="pt2-sub" style="line-height:1.9">' +
          "<b>다중 동시통역방</b>을 만들면 여기에 지갑이 생깁니다.<br>" +
          "방에 크레딧을 넣어두면 방 사람들이 말할 때 거기서 빠져나가요. 직원은 결제하지 않아도 됩니다." +
          "</div></div>";
      }
      return '<div class="tk-sec" style="margin-top:16px">다중 통역방 지갑</div>' +
        '<div class="tk-card" style="padding:6px 10px">' +
          mine.slice(0, 20).map(function (r) {
            return '<div class="pt2-blkrow"><span>' +
              "<b>" + esc(r.name || "이름 없는 방") + "</b>" +
              "<small>" + ((r.members || 1)) + "명</small></span>" +
              '<button class="pt2-blkx" data-pt2="wallet" data-id="' + esc(r.id) +
              '" data-rn="' + esc(r.name || "") + '">지갑</button></div>';
          }).join("") +
        "</div>" +
        '<div class="pt2-note">방마다 <b>누가 낼지</b> 정할 수 있어요.<br>' +
        "· <b>방장이 다 내기</b> — 방 지갑에 넣어두면 방 인원이 말할 때 거기서 빠져나갑니다. 방 인원은 결제하지 않아도 됩니다.<br>" +
        "· <b>각자 내기</b> — 말한 사람이 자기 크레딧으로 냅니다.<br>" +
        "안 쓴 몫은 언제든 되돌려받을 수 있어요.</div>";
    })() +

    /* ── 요금표 ──
       예전에는 줄글이라 눈이 어디를 봐야 할지 몰랐다. 사람은 값을 볼 때
       "무엇이 얼마인가" 두 개만 본다. 그래서 왼쪽에 이름, 오른쪽에 숫자로
       줄을 맞춘다. 무료는 0 이 아니라 '무료' 라고 적는다 —
       0 은 눈에 안 들어오고 '무료' 는 들어온다. */
    '<div class="tk-sec" style="margin-top:18px">무엇이 얼마</div>' +
    (function () {
      var line = function (name, val, sub, free) {
        return '<div style="display:flex;align-items:baseline;gap:10px;padding:9px 0;' +
            'border-bottom:1px solid rgba(0,0,0,.05)">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:13.5px;font-weight:700">' + name + "</div>" +
              (sub ? '<div style="font-size:11px;color:var(--tk-sub,#7b7490);margin-top:2px;' +
                     'line-height:1.5">' + sub + "</div>" : "") +
            "</div>" +
            '<div style="flex:0 0 auto;font-size:14px;font-weight:900;' +
              (free ? "color:#16a34a" : "color:var(--tk-grape,#6d28d9)") + '">' + val + "</div>" +
          "</div>";
      };
      return '<div class="tk-card" style="padding:4px 16px 10px">' +
        line("채팅 · 일반채팅", "무료", "", 1) +
        line("1:1 동시통역", "무료", "둘이 쓰는 통역은 값을 받지 않아요", 1) +
        line("남의 말 듣고 읽기", "무료", "", 1) +
        line("말하기 (받아쓰기)", "1", "") +
        line("채팅방 AI 답", "1", "") +
        line("포도AI · 빠른 답", "2", "") +
        line("다중 동시통역", "3", "한 마디에 방 안의 언어 수만큼 · 세 나라 말이면 3") +
        line("마주보기 통역", "3", "1분에") +
        line("포도AI · 웹검색", "4", "") +
        line("포도AI · 고품질 답", "8", "") +
        line("전화통역", "60", "1분에") +
      "</div>";
    })() +

    '<div class="tk-card" style="padding:14px 16px;margin-top:10px">' +
      '<div style="font-size:12.5px;font-weight:800;margin-bottom:7px">알아두면 좋은 것</div>' +
      '<div class="pt2-sub" style="line-height:1.85">' +
        "· <b>말한 사람만 냅니다.</b> 듣기만 하면 한 푼도 안 듭니다<br>" +
        "· <b>내 AI 키</b>를 넣으면 포도AI 값이 <b>절반</b>이 됩니다<br>" +
        "· 통역은 내 AI 키가 있어도 크레딧이 듭니다<br>" +
        "· 답을 못 받으면 크레딧을 <b>도로 넣어드립니다</b><br>" +
        "· 폰이 직접 읽어주면 공짜, 폰이 못 읽을 때만 서버가 대신합니다" +
      "</div>" +
    "</div>";
  markTab("settings");

  /* 예전에는 잔액을 받아온 뒤 화면을 통째로 다시 그렸다. 그 바람에
     코드를 입력하는 중에 칸이 지워져 글자가 안 들어갔다.
     이제는 숫자와 목록만 제자리에서 바꾼다. */
  cdLoad(function () {
    if ((location.hash || "").indexOf("#/talk/credits") !== 0) return;
    var b = document.getElementById("cdBal");
    if (b && CDS.balance !== null) b.textContent = Number(CDS.balance).toLocaleString();
    var pk = document.getElementById("cdPacks");
    if (pk && CDS.packs && CDS.packs.length) pk.innerHTML = cdPacksHtml();
  });
}
function cdPacksHtml(){
  if (!CDS.packs || !CDS.packs.length) return '<div class="pt2-sub">불러오는 중…</div>';
  return CDS.packs.map(function (k) {
    return '<div class="pt2-blkrow"><span>' +
      "<b>" + Number(k.credits).toLocaleString() + "크레딧</b>" +
      "<small>" + esc(k.label || "") + (k.bonus ? " · " + esc(k.bonus) : "") + "</small></span>" +
      '<button class="pt2-blkx" data-pt2="cd-buy" data-p="' + esc(k.id) + '">' +
      Number(k.krw).toLocaleString() + "원</button></div>";
  }).join("");
}
function cdRedeem(){
  var el = document.getElementById("cdCode");
  var code = ((el && el.value) || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) { say("코드를 넣어주세요"); return; }
  say("확인 중…");
  api("/talk/credits/redeem", { body: { uid: myUid(), code: code } }).then(function (d) {
    if (d && d.ok) {
      CDS.balance = d.balance;
      say(Number(d.added || 0).toLocaleString() + "크레딧이 들어왔어요");
      renderCredits();
    } else {
      say((d && d.error) || "코드를 확인해 주세요");
    }
  }, function (e) { say((e && e.message) || "코드를 확인해 주세요"); });
}



/* ══ 방 지갑 ══
   사장이 방에 크레딧을 넣어둔다. 방 사람들이 말할 때 거기서 빠져나가므로
   사람마다 나눠줄 필요가 없다. 안 쓴 몫은 언제든 되돌려받는다.
   남의 잔액은 어디서도 보이지 않는다. */
var WAL = { id: "", name: "", left: null, pay: "wallet" };
function walletSheet(id, name){
  id = rid(id || (P.id ? P.id : ""));
  if (!id) { say("방을 골라주세요"); return; }
  if (!tokenOf(id)) { say("방을 만든 분만 쓸 수 있어요"); return; }
  WAL.id = id; WAL.name = name || "";
  var sb = document.querySelector(".sheet-bg"); if (sb) sb.remove();
  var bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.setAttribute("data-action", "close-sheet");
  bg.innerHTML = '<div class="sheet" data-action="stop">' +
    '<h3><img src="/podotalk-192.png" alt="" style="width:22px;height:22px;border-radius:7px;vertical-align:-4px;margin-right:6px"> ' + esc(WAL.name || "방") + " 지갑</h3>" +
    '<div class="sd">이 방에서 <b>통역값을 누가 낼지</b> 정합니다.<br>' +
    "누가 얼마나 썼는지는 아무에게도 보이지 않습니다.</div>" +

    '<div class="pt2-pay">' +
      '<button id="payW" data-pt2="pay-w">방장이 다 내기<br><small>방 지갑에서</small></button>' +
      '<button id="payE" data-pt2="pay-e">각자 내기<br><small>말한 사람이</small></button>' +
    "</div>" +
    '<div class="pt2-note" id="payNote"></div>' +

    '<div id="walBox">' +
      '<div class="tk-card" style="padding:14px;text-align:center;margin-top:12px">' +
        '<div class="pt2-sub">방에 남은 크레딧</div>' +
        '<div id="walLeft" style="font-size:30px;font-weight:900;color:var(--tk-grape)">…</div>' +
      "</div>" +
      '<input id="walAmt" class="tk-in" style="margin-top:12px" inputmode="numeric" placeholder="넣을 크레딧" value="1000">' +
      '<button class="cta" style="margin-top:10px" data-pt2="wal-in">방에 넣기</button>' +
      '<button class="cta" style="margin-top:8px;background:#fff;color:var(--tk-grape);border:1.5px solid var(--tk-line);box-shadow:none" data-pt2="wal-out">남은 것 모두 되돌려받기</button>' +
    "</div>" +
    '<button class="cta" style="margin-top:8px;background:#fff;color:var(--sub);border:1.5px solid var(--tk-line);box-shadow:none" data-action="close-sheet">닫기</button>' +
    "</div>";
  document.body.appendChild(bg);
  walLoad();
}
function walLoad(){
  api("/talk/room/wallet?room_id=" + encodeURIComponent(WAL.id) +
      "&uid=" + encodeURIComponent(myUid())).then(function (d) {
    WAL.left = (d && d.wallet) || 0;
    WAL.pay = (d && d.pay) || "wallet";
    var el = document.getElementById("walLeft");
    if (el) el.textContent = Number(WAL.left).toLocaleString();
    walPaint();
  }, function () {});
}
/* 고른 방식에 따라 화면을 바꾼다 */
function walPaint(){
  var w = document.getElementById("payW"), e = document.getElementById("payE");
  var box = document.getElementById("walBox"), note = document.getElementById("payNote");
  if (!w || !e) return;
  var each = WAL.pay === "each";
  w.classList.toggle("on", !each);
  e.classList.toggle("on", each);
  if (box) box.style.display = each ? "none" : "";
  if (note) {
    note.innerHTML = each
      ? "방 인원이 <b>각자 자기 크레딧</b>으로 냅니다. 크레딧이 없는 분은 통역이 안 되고 원문만 전달돼요."
      : "방 지갑에서 빠져나갑니다. <b>방 인원은 결제하지 않아도</b> 통역을 씁니다. 안 쓴 몫은 언제든 되돌려받을 수 있어요.";
  }
}
function walPay(mode){
  api("/talk/room/wallet", { body: { room_id: WAL.id, uid: myUid(), pay: mode }, token: tokenOf(WAL.id) })
    .then(function (d) {
      if (d && d.ok) {
        WAL.pay = d.pay; walPaint();
        say(mode === "each" ? "각자 내기로 바꿨어요" : "방장이 다 내기로 바꿨어요");
      } else say((d && d.error) || "바꾸지 못했어요");
    }, function () { say("바꾸지 못했어요"); });
}
function walIn(){
  var a = parseInt((document.getElementById("walAmt") || {}).value || "0") || 0;
  if (!a) { say("넣을 크레딧을 적어주세요"); return; }
  say("넣는 중…");
  api("/talk/room/wallet", { body: { room_id: WAL.id, uid: myUid(), amount: a }, token: tokenOf(WAL.id) })
    .then(function (d) {
      if (d && d.ok) { say(a.toLocaleString() + "크레딧을 방에 넣었어요"); walLoad(); cdLoad(); }
      else say((d && d.error) || "넣지 못했어요");
    }, function (e) { say((e && e.message) || "내 크레딧이 모자라요"); });
}
function walOut(){
  say("되돌려받는 중…");
  api("/talk/room/wallet", { body: { room_id: WAL.id, uid: myUid(), take: 1 }, token: tokenOf(WAL.id) })
    .then(function (d) {
      if (d && d.ok) { say(Number(d.back || 0).toLocaleString() + "크레딧을 되돌려받았어요"); walLoad(); cdLoad(); }
      else say((d && d.error) || "되돌려받지 못했어요");
    }, function (e) { say((e && e.message) || "되돌려받을 크레딧이 없어요"); });
}

/* ══════════════ 포도AI ══════════════
   포도야(podoya.ai.kr)를 포도톡 안에서 연다. 밖으로 나가버리면 아래 탭 다섯 개가
   사라져서 돌아올 길이 없었다. 여기서 열면 탭이 그대로 남는다. */
var PODOYA = "https://podoya.ai.kr/";
function renderPodoya(){
  /* 머리말을 두지 않는다. 아래 탭에 이미 '포도AI' 라고 적혀 있어서
     같은 말이 위아래로 두 번 나왔고, 그만큼 화면이 좁아졌다.
     좁은 폰에서는 한 줄이 아깝다. */
  var head = "";
  /* ?in=podotalk 을 붙여 보낸다. 포도야가 이 표시를 보고 자기 화면의
     '포도톡' 칸을 숨긴다. 포도톡 안에서 여는 것이라 그 버튼이 또 있으면
     같은 자리를 맴돌게 된다. podoya.ai.kr 을 직접 열면 표시가 없으니 그대로 나온다. */
  /* 기기 토큰을 함께 넘긴다. 포도야가 이걸로 같은 지갑을 본다.
     열쇠(PODO-XXXX-XXXX)가 아니라 기한이 있는 토큰을 넘긴다 —
     주소에 남는 값이므로 새더라도 피해가 작아야 한다.
     아직 열쇠를 안 만든 분은 예전처럼 그냥 열린다(무료 기능만). */
  try { aiDepth = 0; aiMark = false; } catch (e) {}   /* 창을 새로 그리면 처음부터 */
  var _pt = ""; try { _pt = pkToken(); } catch (e) {}
  /* ★ 주소 끝에 여는 시각을 붙이면 안 된다.
     매번 주소가 달라져 브라우저가 캐시를 못 쓰고, 탭을 옮길 때마다
     1.3MB 짜리 화면을 통째로 다시 받는다. 느리거나 중간에 끊기면
     하얀 화면이 된다. 실제로 그랬다.
     주소를 고정해 두면 두 번째부터는 즉시 뜬다. 새 판을 받는 일은
     서비스워커가 알아서 한다. */
  /* 창을 새로 만들면 포도야는 어차피 처음 화면부터 시작한다.
     여기에 home=1 같은 걸 붙여 "홈으로 가라" 고 또 시키면, 아직
     준비도 안 된 화면을 비워버려 흰 화면이 됐다. 아무것도 붙이지 않는다. */
  var _q = "?in=podotalk" + (_pt ? "&pt=" + encodeURIComponent(_pt) : "");
  document.querySelector("#view").innerHTML = head +
    '<div class="pt2-callwrap"><iframe id="pt2-aif" class="pt2-aiframe" src="' + PODOYA + _q + '" ' +
      /* 창 안에서 쓰는 기능은 부모가 허락해줘야 한다.
         web-share 가 없어서 '친구에게 알리기'(카톡 공유)가 아무 반응이
         없었다. 카메라·위치도 같은 이유로 막힐 수 있어 함께 넘긴다. */
      'allow="microphone; camera; geolocation; clipboard-write; web-share"></iframe></div>';

  /* 그래도 안 뜨면 조용히 한 번만 다시 부른다.
     사용자에게 '다시 열기' 단추를 보이는 것보다, 앱이 스스로 회복하는
     편이 낫다. 한 번만 하고 멈춘다 — 계속 반복하면 더 나쁘다. */
  try {
    var _f = document.getElementById("pt2-aif");
    if (_f) {
      var _ok = false;
      _f.addEventListener("load", function () { _ok = true; });
      setTimeout(function () {
        if (_ok) return;
        if (!document.getElementById("pt2-aif")) return;
        try { _f.src = PODOYA + _q + "&r=1"; } catch (e) {}
      }, 3500);
    }
  } catch (e) {}
    /* '포도야에서 바로 열기' 버튼은 뺐다. 새 창으로 열면 크롬이 위에
       '포도야 — 폰에서 바로 쓰는 AI 비서 · podoya.ai.kr' 막대를 붙이는데,
       그건 브라우저가 붙이는 것이라 우리 코드로는 못 없앤다. 바로 이 칸에
       같은 화면이 이미 떠 있으므로 굳이 밖으로 나갈 이유도 없다. */
  markTab("podoya");
  fitAiSoon();
}

/* ── 포도야 창을 탭바 바로 위까지 ──
   창이 시작하는 자리와 탭바 높이를 실제로 재서 남는 만큼 정확히 채운다.
   숫자로 어림잡으면 폰마다 간격이 남거나 넘친다. 화면을 돌리거나 주소창이
   접혔다 펴져도 다시 맞춘다. */
function fitAiFrame(){
  try {
    var f = document.querySelector(".pt2-aiframe");
    if (!f) return;
    var wrap = f.parentNode || f;
    var top = wrap.getBoundingClientRect().top;
    var bar = document.getElementById("talkbar");
    var barH = bar ? bar.getBoundingClientRect().height : 62;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    var h = Math.round(vh - top - barH);
    if (h > 260) f.style.height = h + "px";
  } catch (e) {}
}
/* 화면이 자리를 잡는 데 시간이 걸리므로 몇 번 더 맞춘다 */
function fitAiSoon(){ [0, 120, 400, 900].forEach(function (ms){ setTimeout(fitAiFrame, ms); }); }
try {
  window.addEventListener("resize", fitAiFrame);
  window.addEventListener("orientationchange", fitAiSoon);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", fitAiFrame);
} catch (e) {}

/* ══════════════ 계정 탈퇴 ══════════════
   쓰시는 분이 직접 지울 수 있어야 한다. 운영자에게 메일을 보내 기다리게 하지 않는다. */
function renderQuit(){
  var head = ""; try { head = tkHeader("계정 탈퇴", "⚠️ 되돌릴 수 없음"); } catch (e) {}
  document.querySelector("#view").innerHTML = head +
    '<div class="trx-lead">아래 버튼을 누르면 <b>바로 지워집니다.</b> 신청하고 기다리실 필요가 없습니다.</div>' +
    '<div class="tk-card" style="padding:14px 15px">' +
      '<div class="pt2-sub" style="font-weight:900;color:#B91C1C;margin-bottom:8px">지워지는 것</div>' +
      '<div class="pt2-sub" style="line-height:1.8">' +
        '· 내가 만든 방과 그 안의 대화 (서버에서 삭제)<br>' +
        '· 내가 들어가 있던 방에서 나가기<br>' +
        '· 이 폰에 저장된 모든 것 — 방 목록, 대화명, 프로필 사진, 알림 설정, AI 키, 번호 등록<br>' +
        '· 전화통역의 통화기록 · 저장된 번호 · 용어집 · 이용권 코드<br>' +
        '· 구글 계정 연결 (식별번호 · 이메일 · 이름)<br>· 번호 등록, 알림 주소, 프로필 사진' +
      "</div>" +
    "</div>" +
    '<div class="pt2-sub" style="margin:10px 0 4px">남는 것이 하나 있습니다. <b>다른 사람이 만든 방에 내가 남긴 말</b>은 그 방의 기록이라 지워지지 않습니다. 그 부분은 방을 만든 분에게 삭제를 요청해 주세요.</div>' +
    '<button class="cta" style="margin-top:12px;background:#DC2626;box-shadow:none" data-pt2="quit-go">계정과 모든 자료 지우기</button>' +
    '<div class="pt2-sub" style="text-align:center;margin:10px 0 14px">두 번 확인한 뒤 지웁니다</div>';
  markTab("settings");
}
function quitWipeLocal(){
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  try { if (window.caches && caches.keys) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); }); } catch (e) {}
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); });
    }
  } catch (e) {}
  setTimeout(function () { try { location.replace("/"); } catch (e) { location.href = "/"; } }, 900);
}
function quitAll(){
  say("지우는 중… 잠시만 기다려 주세요");
  var uid = myUid();

  /* 서버의 계정까지 지운다. 구글 로그인을 해 두신 분은 그 자리에서
     구글 확인을 한 번 더 받는다. uid 만으로 지우게 두면 남의 계정을
     지울 수 있게 되기 때문이다. */
  var eraseAccount = function (next) {
    api("/talk/auth/me?uid=" + encodeURIComponent(uid)).then(function (me) {
      if (!me || !me.linked) {
        api("/talk/account/delete", { body: { uid: uid } }).then(next, next);
        return;
      }
      say("탈퇴 확인을 위해 구글 로그인을 한 번 더 확인합니다");
      var done = false;
      var fire = function (cred) {
        if (done) return; done = true;
        api("/talk/account/delete", { body: { uid: uid, id_token: cred } }).then(next, next);
      };
      try {
        gLoad(function (ok2) {
          if (!ok2 || !G_CLIENT_ID) { if (!done) { done = true; next(); } return; }
          google.accounts.id.initialize({
            client_id: G_CLIENT_ID,
            callback: function (res) { fire(res && res.credential); },
            auto_select: true
          });
          google.accounts.id.prompt(function () {});
        });
      } catch (e) { if (!done) { done = true; next(); } }
      /* 구글 창이 안 뜨거나 취소해도 폰 자료는 지운다 */
      setTimeout(function () { if (!done) { done = true; next(); } }, 20000);
    }, function () { next(); });
  };

  api("/talk/rooms?type=mine&uid=" + encodeURIComponent(uid)).then(function (m) {
    var rooms = (m && m.rooms) || [];
    var after = function () { eraseAccount(quitWipeLocal); };
    if (!rooms.length) return after();
    var n = 0;
    var fin = function () { n++; if (n >= rooms.length) after(); };
    rooms.forEach(function (r) {
      var id = r && r.id; if (!id) return fin();
      var tk = tokenOf(id);
      if (tk) api("/talk/room/delete", { body: { room_id: id }, token: tk }).then(fin, fin);
      else api("/talk/room/leave", { body: { room_id: id, uid: uid } }).then(fin, fin);
    });
    /* 서버가 답을 안 줘도 폰 자료는 반드시 지운다 */
    setTimeout(quitWipeLocal, 40000);
  }, function () { eraseAccount(quitWipeLocal); });
}

/* 설정에서 여는 포도랑 화면들 — 통화기록 · 전화통역 설정 · 이용권 */
function renderPodo(kind){
  var M = {
    log: ["통화기록", "log",  "건 번호와 주고받은 말이 남습니다. 이 폰 안에만 저장됩니다."],
    set: ["전화통역 설정", "set", "말투와 용어집을 정합니다. 전화 통역에만 쓰입니다."],
    my:  ["저장현황", "my", "저장된 양과 기록 지우기가 여기 있습니다. 크레딧은 설정 → 크레딧에서 봅니다."]
  };
  var m = M[kind] || M.log;
  var head = ""; try { head = tkHeader(m[0], "📞 전화통역"); } catch (e) {}
  /* 창을 주소와 함께 만들면 그 첫 화면이 뒤로가기 기록에 한 칸 쌓인다.
     그래서 뒤로가기를 눌러도 설정으로 안 가고 창 안에서만 움직였다.
     빈 창을 먼저 만들고 replace 로 채우면 기록에 쌓이지 않는다. */
  document.querySelector("#view").innerHTML = head +
    '<div class="pt2-sub" style="margin:-4px 0 10px">' + m[2] + "</div>" +
    podoFrame(m[1], 1);
  markTab("settings");
  toTop();
  var fr = null;
  try {
    fr = document.querySelector(".pt2-callframe");
    var u = fr && fr.getAttribute("data-src");
    if (fr && u) {
      if (fr.contentWindow && fr.contentWindow.location.replace) fr.contentWindow.location.replace(u);
      else fr.src = u;
    }
  } catch (e) {
    try { fr = document.querySelector(".pt2-callframe"); if (fr) fr.src = fr.getAttribute("data-src"); } catch (e2) {}
  }
  podoBackGuard(fr);
}

/* ── 뒤로가기를 한 번에 ──
   창 안(포도랑)에서 화면이 바뀔 때마다 뒤로가기 기록이 한 칸씩 쌓인다.
   그래서 뒤로가기를 눌러도 설정으로 안 가고 창 안에서만 되돌아갔다.
   창이 새로 뜰 때마다 우리 표식을 하나씩 맨 위에 올려둔다. 그러면 뒤로가기가
   항상 우리 표식을 먼저 만나고, 그때 설정으로 곧장 보낸다. */
var podoPop = null;
function podoBackGuard(fr){
  var mark = function(){ try { history.pushState({ pt2: "podo" }, ""); } catch (e) {} };
  try { if (fr) fr.addEventListener("load", mark); } catch (e) {}
  mark();

  if (podoPop) { try { window.removeEventListener("popstate", podoPop); } catch (e) {} }
  podoPop = function(){
    try { window.removeEventListener("popstate", podoPop); } catch (e) {}
    podoPop = null;
    try { if (fr) fr.removeEventListener("load", mark); } catch (e) {}
    var b = document.getElementById("tk-tab-settings");
    if (b) b.click(); else { try { location.hash = "#/talk"; } catch (e) {} }
  };
  window.addEventListener("popstate", podoPop);
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
  if (sub === "calllog") { renderPodo(arg || "log"); toTop(); return; }
  if (sub === "quit") { renderQuit(); return; }
  if (sub === "podoya") { renderPodoya(); return; }
  if (sub === "credits") { renderCredits(); toTop(); return; }
  if (sub === "safety")  { renderSafety(); return; }
  if (sub === "blocked") { renderBlocked(); return; }
  if (sub === "new") { renderNew(); return; }
  if (sub === "profile") { renderProfile(); return; }
  if (sub === "trans") {
    if (arg) return trxRoom(arg);
    var k = lseg();
    if (k === "call") return renderCall();
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
    if (!d || !d.ok) {
      var gm = document.getElementById("pt2-gate-msg");
      if (gm) gm.textContent = (d && d.error) || "로그인하지 못했어요";
      say((d && d.error) || "로그인하지 못했어요"); return;
    }
    /* 서버가 정해준 계정 uid 로 이 폰을 맞춘다. 이게 곧 계정 이어받기다. */
    try { window.DB.set("pododa_uid", d.uid); } catch (e) {}
    LSS("pt2_acct", JSON.stringify({ email: d.email || "", name: d.name || "" }));
    try { gateHide(); } catch (e3) {}
    if (d.gift) say("환영합니다 · 크레딧 " + d.gift + "개를 드렸어요");
    else if (d.moved) say(d.moved + "개 방을 계정으로 옮겼어요");
    else say("로그인했어요");
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

/* 로그인 창을 열어 그 자리에서 받은 증명서를 넘겨준다.
   gLogin 은 받은 증명서로 계정을 묶는 일까지 하지만, 계정 열쇠를
   받을 때는 증명서만 필요하다. 그래서 따로 둔다. */
function gAsk(cb) {
  if (!G_CLIENT_ID) { say("구글 로그인이 준비되지 않았어요"); return; }
  gLoad(function (ok2) {
    if (!ok2) { say("구글 로그인을 불러오지 못했어요"); return; }
    try {
      google.accounts.id.initialize({
        client_id: G_CLIENT_ID,
        callback: function (res) { if (res && res.credential) cb(res.credential); },
        auto_select: true
      });
      google.accounts.id.prompt(function (n) {
        if (n && n.isNotDisplayed && n.isNotDisplayed()) {
          say("구글 계정 선택 창이 막혔어요. 크롬에서 구글에 로그인돼 있는지 확인해 주세요");
        }
      });
    } catch (e) { say("구글 로그인을 열지 못했어요"); }
  });
}

/* ══════════════ 계정 지갑 ══════════════
   포도야(podoya.ai.kr)는 주소가 달라서, 포도톡 안에 떠 있어도 크롬이
   저장소를 다른 칸으로 관리한다. 그래서 포도야는 이 폰의 크레딧을
   볼 수가 없다. 열쇠를 한 번 넣어주면 그때부터 같은 지갑을 쓴다.

   열쇠는 구글 로그인을 거친 분에게만 내준다. uid 는 참여자 목록에
   그대로 드러나므로 그것만으로는 주인을 확인할 수 없기 때문이다. */
/* 여닫이(드롭다운) 모양 — 눌러서 아래로 열고 다시 접는다 */
(function () {
  try {
    if (document.getElementById("pt2-fold-css")) return;
    var st = document.createElement("style");
    st.id = "pt2-fold-css";
    st.textContent =
      ".pt2-fold > summary{list-style:none;cursor:pointer;display:flex;align-items:center;" +
        "gap:8px;padding:13px 15px;border-radius:14px;background:rgba(0,0,0,.04);" +
        "font-size:13px;font-weight:800}" +
      ".pt2-fold > summary::-webkit-details-marker{display:none}" +
      ".pt2-fold[open] > summary{margin-bottom:8px}" +
      ".pt2-fold[open] > summary .fold-ar{transform:rotate(180deg)}" +
      ".pt2-fold .fold-ar{font-size:13px;transition:transform .18s}";
    document.head.appendChild(st);
  } catch (e) {}
})();

function pkGet()  { return LSJ("pt2_pkey", null); }
function pkSave(o){ LSS("pt2_pkey", JSON.stringify(o)); }
function pkToken(){ var o = pkGet(); return (o && o.token) || ""; }

function pkMake(renew) {
  say("구글 확인 중…");
  gAsk(function (cred) {
    api("/talk/account/key", { body: { uid: myUid(), id_token: cred, renew: renew ? 1 : 0 } })
      .then(function (d) {
        if (!d || !d.ok) { say((d && d.error) || "지갑을 만들지 못했어요"); return; }
        pkSave({ key: d.key, token: d.token, ts: Date.now() });
        /* 서버가 정해준 계정 uid 로 이 폰을 맞춘다 */
        try { if (d.uid) window.DB.set("pododa_uid", d.uid); } catch (e) {}
        say(renew ? "새 지갑을 만들었어요. 옛 지갑은 이제 못 씁니다" : "지갑을 만들었어요");
        if ((location.hash || "").indexOf("#/talk/credits") === 0) renderCredits();
      });
  });
}
function pkCopy() {
  var o = pkGet();
  if (!o || !o.key) { say("먼저 지갑을 만들어주세요"); return; }
  try {
    navigator.clipboard.writeText(o.key);
    say("지갑을 복사했어요");
  } catch (e) { say("복사가 안 되면 글자를 길게 눌러 복사해 주세요"); }
}
function pkRenew() {
  if (!confirm("새 지갑을 만들면 지금 지갑은 그 자리에서 못 쓰게 됩니다.\n" +
               "포도야에 다시 넣어야 합니다.\n\n계속할까요?")) return;
  pkMake(1);
}

/* 지갑 칸 — 처음 보는 분이 바로 알아볼 수 있게 크게 둔다 */
function pkCardHtml() {
  var ic = '<img src="/podotalk-192.png" alt="" style="width:17px;height:17px;border-radius:6px;vertical-align:-3px;margin-right:5px">';
  var o = pkGet();
  if (!o || !o.key) {
    return '<div class="tk-card" style="padding:16px">' +
      '<div style="font-size:15px;font-weight:800;margin-bottom:6px">' + ic +
        "포도AI에서도 이 크레딧 쓰기</div>" +
      '<div class="pt2-sub" style="line-height:1.7;margin-bottom:12px">' +
        "포도AI는 주소가 달라서 이 크레딧을 못 봅니다.<br>" +
        "지갑을 한 번 만들어 두면 포도톡과 포도AI가 지갑 하나를 같이 씁니다.</div>" +
      '<button class="cta" data-pt2="pk-make">지갑 만들기</button>' +
      '<div class="pt2-sub" style="margin-top:9px;font-size:11px">구글 로그인 한 번이 필요합니다. ' +
        "폰을 바꿔도 크레딧이 따라오게 하려면 어차피 필요한 절차입니다.</div>" +
    "</div>";
  }
  return '<div class="tk-card" style="padding:16px">' +
    '<div style="font-size:15px;font-weight:800;margin-bottom:8px">' + ic + "내 계정 지갑</div>" +
    '<div style="background:var(--tk-bg2,#f4f6fb);border-radius:12px;padding:14px;text-align:center;' +
      'font-size:21px;font-weight:900;letter-spacing:2px;word-break:break-all">' + esc(o.key) + "</div>" +
    '<button class="cta" style="margin-top:11px" data-pt2="pk-copy">지갑 복사</button>' +
    '<div class="pt2-sub" style="margin-top:10px;line-height:1.7">' +
      "포도톡 · 포도야에서만 사용하는 지갑입니다.</div>" +
    '<div style="text-align:center;margin-top:10px">' +
      '<button data-pt2="pk-renew" style="border:none;background:none;color:var(--tk-sub);' +
        'font-size:11.5px;text-decoration:underline;cursor:pointer;font-family:inherit">' +
        "새로 만들기</button></div>" +
  "</div>";
}

/* ══════════════ 로그인 문 ══════════════
   앱 전체에 문을 하나만 둔다. 포도AI·채팅·통역톡이 크레딧 지갑 하나를
   같이 쓰기로 했으니, 로그인도 한 번이면 된다. 기능마다 따로 물어보면
   같은 사람에게 세 번 묻는 꼴이 된다.

   문을 세우는 이유는 두 가지다.
     ① 폰을 바꿔도 크레딧과 방이 따라오게 하려면 계정이 있어야 한다.
     ② 가입 선물을 uid 로 주면 앱을 지웠다 깔기를 반복해 얼마든지
        받아갈 수 있다. 구글 계정 번호로 줘야 한 번으로 끝난다.

   화면 위에 덮는 방식이라 기존 라우팅은 건드리지 않는다.
   로그인하면 떼어내고, 로그아웃하면 다시 덮는다. */
function gateOn() { return !acct(); }

/* ── 권한은 미리 못 받아둔다 ──
   브라우저는 "쓸 때" 묻는다. 그래서 여기서 하는 일은 그 물음을 지금
   한 번에 띄워주는 것뿐이다. 각 버튼이 사용자의 누름(제스처)이라야
   크롬이 창을 띄워준다. 그래서 한꺼번에 세 개를 자동으로 부르지 않고
   버튼을 셋으로 나눠 둔다.
   알림과 연락처는 여기서 묻지 않는다. 처음 화면에서 다섯 개를 물으면
   대부분 다 거절한다. 그 둘은 실제로 쓸 때 묻는 편이 훨씬 잘 허용된다. */
function gatePerm(kind, btn) {
  var done = function (ok) {
    if (!btn) return;
    btn.textContent = ok ? "켜짐" : "거절됨";
    btn.style.background = ok ? "#dcfce7" : "#f1f0f5";
    btn.style.color = ok ? "#166534" : "#8a8598";
    btn.disabled = true;
  };
  try {
    if (kind === "geo") {
      if (!navigator.geolocation) { done(false); return; }
      navigator.geolocation.getCurrentPosition(function () { done(true); },
        function () { done(false); }, { timeout: 8000 });
      return;
    }
    var want = (kind === "cam") ? { video: true } : { audio: true };
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { done(false); return; }
    navigator.mediaDevices.getUserMedia(want).then(function (st) {
      /* 확인만 하고 바로 끈다. 켜둔 채로 두면 카메라 불이 계속 켜져 있다. */
      try { st.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      done(true);
    })["catch"](function () { done(false); });
  } catch (e) { done(false); }
}

function gateHtml() {
  var ic = '<img src="/podotalk-192.png" alt="" ' +
    'style="width:62px;height:62px;border-radius:19px;display:block;margin:0 auto 13px">';
  var perms = [
    ["mic", "🎤", "마이크", "말하기 · 통역할 때"],
    ["cam", "📷", "카메라", "사진을 찍어 올릴 때"],
    ["geo", "📍", "위치", "날씨 · 길안내할 때"]
  ];
  var rows = "";
  for (var i = 0; i < perms.length; i++) {
    rows += '<div style="display:flex;gap:9px;align-items:center;padding:7px 0">' +
      '<span style="font-size:16px;width:21px;flex:0 0 21px;text-align:center">' + perms[i][1] + "</span>" +
      '<span style="flex:1;min-width:0">' +
        '<span style="font-size:13px;font-weight:700;display:block">' + perms[i][2] + "</span>" +
        '<span style="font-size:11.5px;color:var(--tk-sub,#7b7490)">' + perms[i][3] + "</span>" +
      "</span>" +
      '<button data-perm="' + perms[i][0] + '" style="flex:0 0 auto;border:none;border-radius:9px;' +
        'padding:7px 13px;background:#ede9fe;color:#6d28d9;font-size:12px;font-weight:800;' +
        'cursor:pointer;font-family:inherit">허용</button>' +
    "</div>";
  }
  return '<div id="pt2-gate" style="position:fixed;inset:0;z-index:99999;display:flex;' +
      'align-items:center;justify-content:center;padding:20px;' +
      'background:rgba(30,22,52,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)">' +
    '<div style="width:100%;max-width:360px;max-height:92vh;overflow:auto;background:#fff;' +
      'border-radius:22px;padding:26px 20px 22px;box-shadow:0 18px 50px rgba(0,0,0,.28)">' +
      '<div style="text-align:center;margin-bottom:20px">' + ic +
        '<div style="font-size:22px;font-weight:900;letter-spacing:-.5px">포도톡</div>' +
        '<div style="font-size:13px;color:var(--tk-sub,#7b7490);margin-top:6px">' +
          "AI 자동화 · 통역을 한 곳에서</div>" +
      "</div>" +

      /* 보이는 것은 우리 버튼, 실제로 눌리는 것은 그 위에 투명하게 덮은
         구글 버튼이다. google.accounts.id.prompt() 는 크롬이 자주
         억눌러서 아무 일도 안 일어난다. 구글이 직접 그린 버튼은 확실히
         계정 선택 창을 띄운다. */
      '<div style="position:relative">' +
        '<button id="pt2-gate-go" style="width:100%;border:none;border-radius:14px;padding:15px;' +
          'background:#ede9fe;color:#5b21b6;font-size:15px;font-weight:800;cursor:pointer;' +
          'font-family:inherit">구글로 시작하기</button>' +
        '<div id="pt2-gbtn" style="position:absolute;inset:0;opacity:.001;overflow:hidden"></div>' +
      "</div>" +
      '<div id="pt2-gate-msg" style="font-size:12px;color:var(--tk-sub,#7b7490);' +
        'text-align:center;margin-top:9px;min-height:16px"></div>' +

      '<div style="margin-top:16px;border-top:1px solid rgba(0,0,0,.08);padding-top:12px">' +
        '<div style="font-size:12px;font-weight:800;margin-bottom:4px">먼저 켜두면 편한 것</div>' +
        rows +
        '<div style="font-size:11px;color:var(--tk-sub,#7b7490);margin-top:8px;line-height:1.6">' +
          "알림 · 연락처는 나중에 필요할 때 물어봅니다.</div>" +
      "</div>" +
    "</div></div>";
}

function gateShow() {
  if (document.getElementById("pt2-gate")) return;
  var d = document.createElement("div");
  d.innerHTML = gateHtml();
  var g = d.firstChild;
  document.body.appendChild(g);
  /* 구글 버튼을 겹쳐 그린다. 스크립트를 못 받아오면 우리 버튼이
     예전 방식(One Tap)으로 대신 동작한다. */
  gateDrawGoogle();
  var b = document.getElementById("pt2-gate-go");
  if (b) b.addEventListener("click", function () {
    var m = document.getElementById("pt2-gate-msg");
    if (m) m.textContent = "구글 계정을 확인하는 중…";
    gLogin();
  });
  g.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute("data-perm")) {
      gatePerm(t.getAttribute("data-perm"), t);
    }
  });
}
function gateDrawGoogle() {
  gLoad(function (ok2) {
    var box = document.getElementById("pt2-gbtn");
    if (!ok2 || !box) return;
    try {
      google.accounts.id.initialize({
        client_id: G_CLIENT_ID,
        callback: function (res) {
          var m = document.getElementById("pt2-gate-msg");
          if (m) m.textContent = "구글 계정을 확인하는 중…";
          if (res && res.credential) gSend(res.credential);
        },
        auto_select: false
      });
      var w = Math.round(box.getBoundingClientRect().width) || 300;
      if (w < 200) w = 200; if (w > 400) w = 400;
      google.accounts.id.renderButton(box, {
        type: "standard", theme: "outline", size: "large",
        text: "continue_with", width: w
      });
    } catch (e) {}
  });
}
function gateHide() {
  var g = document.getElementById("pt2-gate");
  if (g) g.remove();
}
function gateCheck() { if (gateOn()) gateShow(); else gateHide(); }

function gLogout() {
  if (!confirm("로그아웃하면 이 폰에서 방 목록이 비워집니다.\n다시 로그인하면 그대로 돌아옵니다.\n\n로그아웃할까요?")) return;
  try { localStorage.removeItem("pt2_acct"); } catch (e) {}
  /* uid 를 새로 만들어 이 폰을 빈 상태로 되돌린다. 서버 자료는 지우지 않는다. */
  try { window.DB.set("pododa_uid", "u_" + Math.random().toString(36).slice(2, 10)); } catch (e2) {}
  say("로그아웃했어요");
  try { gateShow(); } catch (e4) {}
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
/* 사진을 안 넣은 분에게 보여줄 기본 얼굴. 이모지를 고르게 하면 고르는 것도
   일이고, 방마다 다르게 보여 헷갈렸다. 사진이 없으면 단색 원 하나만 둔다. */
function solidAv(){
  return '<span style="display:inline-block;width:100%;height:100%;border-radius:50%;' +
         'background:#8b35e0"></span>';
}

function renderProfile() {
  var av = "";
  try { av = window.talkAvatar ? window.talkAvatar() : ""; } catch (e) {}
  var isPh = false;
  try { isPh = !!(window.isPhoto && window.isPhoto(av)); } catch (e) {}
  var face = isPh ? imgAv(av) : solidAv();

  document.querySelector("#view").innerHTML =
    '<div class="tk-rhead"><span class="tk-back" data-pt2="prof-back">‹</span>' +
      '<div class="tk-rh-mid"><div class="tk-hi">프로필 편집</div>' +
      '<div class="tk-hs">사진 · 대화명</div></div></div>' +
    '<div class="tk-set">' +
      '<div class="tk-prof">' +
        '<div class="tk-prof-av">' + face + "</div>" +
        '<div class="tk-prof-mid"><div class="tk-prof-nm">' + esc(myNick()) + '</div>' +
          '<div class="tk-prof-sub">내 프로필</div></div>' +
        '<button class="tk-prof-btn" data-action="talk-pick-photo">사진 변경</button>' +
      "</div>" +
      '<input id="tkAvatarFile" type="file" accept="image/*" style="display:none">' +
      '<div class="tk-field"><label>내 대화명(닉네임)</label>' +
        '<input id="tkNick" value="' + esc(myNick()) + '" placeholder="포도" autocomplete="off"></div>' +
      '<button class="cta" style="background:#fff;color:#111;border:1.5px solid var(--tk-line);box-shadow:none" data-action="talk-save-nick">닉네임 저장</button>' +
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
      : '<div class="pt2-sub">사진과 이름은 본인만 바꿀 수 있어요.</div>' +
        '<div class="tk-tools" style="margin-top:12px">' +
          '<button class="tk-tool" data-pt2="blk-add" data-u="' + esc(m.uid || "") + '" data-n="' + esc(nm) + '">🚫 차단</button>' +
          '<button class="tk-tool" data-pt2="rep-open" data-u="' + esc(m.uid || "") + '" data-n="' + esc(nm) + '">🚨 신고</button>' +
        "</div>") +
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
/* 번역은 한 길만 씁니다. 예전에는 화면에서 "정밀번역 / 무료 번역" 을 고르게
   했는데, '정밀' 은 기준이 사람마다 다르고 '무료' 도 듣기에 크레딧이 나가므로
   이름이 실제와 맞지 않았습니다. 고르는 칸을 없애고 포도랑 쪽으로 모았습니다.
   나중에 반대로 바꾸려면 아래 "podo" 를 "free" 로 고치면 됩니다.
   예전에 폰에 저장해 둔 값(pt2_trx_engine)은 이제 보지 않습니다. */
function trxEngine(){ return "podo"; }

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
  /* 크레딧이 없을 때(402)는 무료 번역기로 넘어가지 않습니다. 넘어가면 아무도
     내지 않고 쓰는 길이 열립니다. 서버가 잠깐 안 될 때(그물망·시간초과)는
     예전처럼 예비길로 갑니다. 그건 손님 잘못이 아니기 때문입니다. */
  trxPodolang(text, fromC, toC, function(o,e){ ok(o,e); }, free, function(){
    say("크레딧이 필요해요. 설정 → 크레딧에서 채워주세요");
    ok("", "🔒 크레딧 필요");
  });
}
function trxPodolang(text, fromC, toC, ok, fail, noCredit){
  try{
    var to=setTimeout(function(){ to=null; fail(); }, 12000);
    fetch(TRX_API+"/api/translate", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ text:text, sourceLang:fromC, targetLang:toC, uid:myUid() }) })
      .then(function(r){
        /* 402 는 '크레딧 없음' 입니다. 다른 실패와 구별해야 합니다. */
        if(r.status===402){ var ec=new Error("nocredit"); ec.nocredit=1; throw ec; }
        if(!r.ok) throw 0; return r.json(); })
      .then(function(d){
        if(to===null) return; clearTimeout(to);
        var out = d && d.translated ? String(d.translated).trim() : "";
        if(!out){ fail(); return; }
        ok(out, "포도랑·"+(d.engine||"GPT"));
      })["catch"](function(ec){
        if(to===null) return; clearTimeout(to);
        if(ec && ec.nocredit && noCredit){ noCredit(); return; }
        fail();
      });
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

/* ── 폰이 읽어주기 ──
   안드로이드 크롬은 까다롭습니다.
   ① 버튼을 누른 그 순간에 바로 speak() 를 불러야 합니다.
      setTimeout 으로 한 박자 미루면 "사용자가 누른 것" 이 아니게 되어 막힙니다.
   ② 받아쓰기(마이크)가 켜져 있으면 소리가 나오지 않습니다.
   ③ cancel() 직후에는 삼켜지는 일이 있어, 상태를 보고 필요할 때만 부릅니다.
   ④ 목소리 목록이 늦게 오면 그 언어 목소리를 못 찾습니다. 그때는 기본 목소리로 읽습니다.

   그리고 소리가 정말 안 나면 조용히 있지 않고 화면에 알려줍니다.
   예전에는 실패해도 아무 말이 없어서 무엇이 문제인지 알 수가 없었습니다. */
function trxVoices(){
  try{ return window.speechSynthesis.getVoices() || []; }catch(e){ return []; }
}
function trxPickVoice(want){
  var vs = trxVoices();
  if(!vs.length) return null;
  var w = String(want||"").toLowerCase(), base = w.split("-")[0];
  for(var i=0;i<vs.length;i++) if(String(vs[i].lang||"").toLowerCase()===w) return vs[i];
  for(var j=0;j<vs.length;j++) if(String(vs[j].lang||"").toLowerCase().replace("_","-").indexOf(base)===0) return vs[j];
  return null;
}
function trxSay(text, langC){
  text = String(text || "").trim();
  if(!text) return;
  /* 누른 그 순간에 소리통을 열어둡니다. 뒤로 미루면 크롬이 막습니다. */
  try{ srvAudioUnlock(); }catch(e){}
  if(!window.speechSynthesis || !window.SpeechSynthesisUtterance){
    srvSay(text, langC);           /* 폰이 못 읽으면 서버가 만들어 줍니다 */
    return;
  }
  var want = trxBcp(langC);
  var S = window.speechSynthesis;

  /* 마이크가 돌고 있었으면 안드로이드가 엔진을 놓을 때까지 잠깐 기다립니다.
     바로 읽으면 synthesis-failed 가 납니다. 이게 소리가 안 나던 이유입니다. */
  var wasBusy = false;
  try{ wasBusy = micBusy(); }catch(e){}
  try{ pt2MicStop(); }catch(e){}
  try{ trxMicStop(); }catch(e){}
  try{ if(typeof trxSrvStop === "function" && typeof trxMR !== "undefined" && trxMR) trxSrvStop(); }catch(e){}

  var tries = 0;
  var run = function(){
    tries++;
    try{ if(S.speaking || S.pending) S.cancel(); }catch(e){}
    try{ if(S.paused) S.resume(); }catch(e){}

    var u = new SpeechSynthesisUtterance(text);
    u.lang = want; u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
    var v = trxPickVoice(want);
    if(v) u.voice = v;                 /* 없으면 폰 기본 목소리로 읽습니다 */

    var started = false;
    u.onstart = function(){ started = true; };
    u.onerror = function(ev){
      var why = (ev && ev.error) || "";
      if(why === "interrupted" || why === "canceled") return;
      /* 엔진이 아직 안 풀렸을 수 있습니다. 조금 더 기다렸다가 한 번 더. */
      if(tries < 2){ setTimeout(run, 450 * tries); return; }
      srvSay(text, langC);          /* 그래도 안 되면 서버가 만들어 줍니다 */
    };

    try{ S.speak(u); }
    catch(e){
      if(tries < 2){ setTimeout(run, 450 * tries); return; }
      srvSay(text, langC);
      return;
    }

    setTimeout(function(){
      if(started || S.speaking || S.pending) return;
      if(tries < 2){ run(); return; }
      /* 폰이 못 읽습니다. 서버에 소리를 청합니다. (크레딧 1) */
      srvSay(text, langC);
    }, 1200);
  };

  /* 마이크를 쓰던 중이었으면 한 박자 쉬고, 아니면 바로 읽습니다.
     바로 읽어야 크롬이 "사용자가 누른 것" 으로 봐줍니다. */
  if(wasBusy) setTimeout(run, 350);
  else run();
}

/* ── 서버가 소리를 만들어 보내주기 ──
   폰이 읽어주지 못하는 기기가 있습니다. 목소리가 92개나 있어도
   크롬이 소리를 못 내는 경우가 실제로 있었습니다.
   그럴 때만 서버(포도랑 ElevenLabs)에 소리를 청해 mp3 로 받아 재생합니다.
   보통 소리 파일이라 폰 상태와 무관하게 확실히 납니다.

   돈이 드는 길이라 크레딧 1개를 받습니다.
   폰으로 되는 분은 여전히 공짜입니다. */
/* ── 소리 잠금 풀기 (Web Audio) ──
   안드로이드 크롬은 사람이 누른 그 순간에만 소리를 허용합니다. 서버에서
   mp3 를 받아오는 데 몇 초가 걸려서, 도착했을 땐 이미 늦습니다.

   지난 판에서는 <audio> 소리통 하나를 미리 열어두는 방식을 썼는데,
   잠금 풀기가 실패하면 화면을 누를 때마다 그 소리통의 내용을 무음 조각으로
   덮어써서 눌러도 무음만 났습니다. 같은 통을 둘이 나눠 쓴 것이 잘못이었습니다.

   그래서 소리길(AudioContext)로 바꿉니다. 소리길은 한 번 열어두면
   페이지가 살아 있는 동안 계속 열려 있고, 무엇을 트는지와 상관이 없어서
   덮어쓰는 일이 생기지 않습니다. mp3 도 소리길로 바로 흘려보냅니다. */
var srvActx = null, srvNode = null;
function srvCtx(){
  if(srvActx) return srvActx;
  var C = window.AudioContext || window.webkitAudioContext;
  if(!C) return null;
  try{ srvActx = new C(); }catch(e){ srvActx = null; }
  return srvActx;
}
/* 무엇을 누르든 그때 소리길을 열어둡니다. 이미 열려 있으면 아무 일도 안 합니다. */
function srvAudioUnlock(){
  var c = srvCtx();
  if(!c || c.state === "running") return;
  try{ c.resume(); }catch(e){}
}
try{
  document.addEventListener("touchend", srvAudioUnlock, true);
  document.addEventListener("click", srvAudioUnlock, true);
}catch(e){}

/* 받아둔 소리를 실제로 흘려보냅니다 */
function srvPlayBuf(buf){
  var c = srvCtx();
  if(!c || !buf) return false;
  try{
    if(srvNode){ try{ srvNode.stop(); }catch(e){} }
    var n = c.createBufferSource();
    n.buffer = buf;
    n.connect(c.destination);
    n.start(0);
    srvNode = n;
    return true;
  }catch(e){ return false; }
}

/* 소리길이 아직 잠겨 있으면, 다음에 누르는 순간 틀어드립니다.
   크레딧은 이미 냈으니 서버에 다시 청하지 않고 받아둔 소리를 그대로 씁니다. */
function srvTapToPlay(buf){
  say("화면을 한 번 누르면 소리가 나요");
  var go = function(){
    document.removeEventListener("touchend", go, true);
    document.removeEventListener("click", go, true);
    var c = srvCtx();
    if(!c){ return; }
    var p = null;
    try{ p = (c.state === "running") ? null : c.resume(); }catch(e){}
    if(p && p.then) p.then(function(){ srvPlayBuf(buf); }, function(){});
    else srvPlayBuf(buf);
  };
  try{
    document.addEventListener("touchend", go, true);
    document.addEventListener("click", go, true);
  }catch(e){}
}

/* 소리길이 열려 있으면 바로, 아니면 열고 나서 틉니다 */
function srvGo(buf){
  var c = srvCtx();
  if(!c) return false;
  if(c.state === "running") return srvPlayBuf(buf);
  var p = null;
  try{ p = c.resume(); }catch(e){}
  if(p && p.then){
    p.then(function(){ if(!srvPlayBuf(buf)) srvTapToPlay(buf); },
           function(){ srvTapToPlay(buf); });
    return true;
  }
  srvTapToPlay(buf);
  return true;
}

/* 서버가 무엇을 보냈는지 적어둔다. 재생이 안 될 때 원인을 가리는 데 쓴다. */
var srvCT = "";

/* 소리길을 못 쓰는 기기를 위한 예비길 — 예전 방식 그대로 <audio> 로 틉니다 */
function srvPlayBlob(ab, n){
  var tail = " (" + (srvCT || "형식없음") + " · " + (n || 0) + "바이트)";
  try{
    var url = URL.createObjectURL(new Blob([ab], { type: "audio/mpeg" }));
    var a = new Audio(url);
    a.onended = function(){ try{ URL.revokeObjectURL(url); }catch(e){} };
    var p = a.play();
    if(p && p["catch"]) p["catch"](function(err){
      say("소리를 재생하지 못했어요" + tail + " " + ((err && err.name) || ""));
    });
  }catch(e){ say("소리를 재생하지 못했어요" + tail); }
}

var srvSayBusy = false;
function srvSay(text, langC, quiet){
  text = String(text || "").trim();
  if(!text || srvSayBusy) return;
  srvSayBusy = true;
  /* 안내문구는 띄우지 않습니다. 1~2초면 소리가 나는데 그 사이에 검은 딱지가
     떴다 사라지면 오히려 뭔가 잘못된 것처럼 보입니다. quiet 는 부르는 쪽에서
     쓰던 것이라 자리는 그대로 둡니다. */

  fetch(TRX_API + "/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.slice(0, 500),
      lang: trxG(langC),
      uid: myUid()
    })
  }).then(function(r){
    srvCT = String((r.headers && r.headers.get("content-type")) || "");
    if(!r.ok){
      return r.json().then(function(j){ throw new Error((j && j.error) || "소리를 만들지 못했어요"); },
                           function(){ throw new Error("소리를 만들지 못했어요"); });
    }
    return r.arrayBuffer();
  }).then(function(ab){
    srvSayBusy = false;
    var n = (ab && ab.byteLength) || 0;

    /* ── 온 것이 소리가 맞는지 먼저 본다 ──
       재생이 안 될 때 "소리를 재생하지 못했어요" 만 뜨면 폰 탓인지 서버 탓인지
       알 수가 없다. 소리가 아니면 서버가 무슨 말을 보냈는지 그대로 보여준다.
       mp3 는 아무리 짧아도 수 KB 는 된다. */
    if(n < 1200 || srvCT.indexOf("audio") < 0){
      var t = "";
      try{ t = new TextDecoder("utf-8").decode(ab).slice(0, 140); }catch(e){}
      say("소리가 아닙니다 [" + (srvCT || "형식없음") + " · " + n + "바이트] " + t);
      return;
    }

    var c = srvCtx();
    if(!c){ srvPlayBlob(ab, n); return; }     /* 소리길을 못 쓰는 기기 */
    try{
      c.decodeAudioData(ab.slice(0),
        function(buf){ srvGo(buf); },
        function(){ srvPlayBlob(ab, n); });   /* 못 풀면 예비길로 */
    }catch(e){ srvPlayBlob(ab, n); }
  })["catch"](function(e){
    srvSayBusy = false;
    say((e && e.message) || "소리를 만들지 못했어요");
  });
}

/* ── 설정에서 눌러보는 소리 시험 ──
   전에는 "목소리 92개 · 소리를 냅니다" 만 띄우고 끝이었다. 소리가 안 나도
   왜 안 나는지 알 길이 없었고, 안 되면 조용히 서버 소리로 넘어가 크레딧만
   나갔다. 시험은 결과를 말해줘야 시험이다.

   그래서 여기서는 폰 읽기 엔진을 '직접' 부른다. 누른 그 순간에 부르는 것이
   중요하다. 크롬은 사람이 누른 직후가 아니면 소리를 막는다. 사이에 다른
   일을 끼우면 그것만으로 막힌다.
   폰이 못 읽으면 그 이유를 적어주고, 그때만 서버 소리로 넘어간다. */
function trxSayTest(){
  var n = 0; try{ n = trxVoices().length; }catch(e){}
  var S = window.speechSynthesis;
  if(!S || !window.SpeechSynthesisUtterance){
    say("이 폰은 읽어주기를 지원하지 않아요 · 서버 소리로 시험합니다");
    try{ srvSay("소리 시험입니다. 잘 들리시나요?", "KO"); }catch(e){}
    return;
  }

  var u = new SpeechSynthesisUtterance("소리 시험입니다. 잘 들리시나요?");
  u.lang = "ko-KR"; u.volume = 1.0; u.rate = 1.0; u.pitch = 1.0;
  try{ var v = trxPickVoice("ko-KR"); if(v) u.voice = v; }catch(e){}

  var started = false, why = "";
  u.onstart = function(){ started = true; say("🔊 소리가 나오고 있어요"); };
  u.onerror = function(ev){ why = (ev && ev.error) || "알 수 없음"; };

  try{ S.resume(); }catch(e){}
  try{ S.speak(u); }
  catch(e){ why = "speak 실패"; }

  setTimeout(function(){
    if(started || S.speaking || S.pending) return;
    /* 폰이 못 읽었다. 무엇 때문인지 알려주고 서버 소리로 넘어간다. */
    say("폰이 소리를 못 냈어요 (" + (why || "이유 없음") + ") · 목소리 " + n +
        "개 · 미디어 볼륨과 무음모드를 확인해 주세요");
    try{ srvSay("소리 시험입니다. 잘 들리시나요?", "KO"); }catch(e){}
  }, 1400);
}

/* ── 마이크 ① 폰 받아쓰기 ── */
var trxRec=null;
function trxMicSupported(){ return !!(window.SpeechRecognition||window.webkitSpeechRecognition); }
function trxMicStop(){
  /* stop() 만으로는 안드로이드가 엔진을 놓지 않습니다. abort() 로 끊습니다. */
  if(trxRec){
    try{ trxRec.onresult = trxRec.onend = trxRec.onerror = null; }catch(e){}
    try{ trxRec.abort(); }catch(e){}
    try{ trxRec.stop(); }catch(e){}
  }
  trxRec=null;
  var b=document.getElementById("trxMic"); if(b) b.classList.remove("rec");
  var h=document.getElementById("trxHint"); if(h) h.textContent="";
}
/* 마이크가 돌고 있는가 */
function micBusy(){ return !!(pt2Rec || trxRec || (typeof trxMR !== "undefined" && trxMR)); }
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
  /* 이게 없으면 크레딧이 아무리 많아도 서버가 '사용자 정보가 없습니다' 로 막습니다.
     폰이 받아쓰기를 지원하지 않는 기기(아이폰 사파리 등)만 이 길로 옵니다. */
  fd.append("uid", myUid());
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
  if (h.indexOf("#/talk/trans") === 0) { return lseg() === "call" ? renderCall() : lseg() === "trx" ? trxList() : renderLive(lseg()); }
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
  if (a === "safety")  { location.hash = "#/talk/safety";  return; }
  if (a === "blocked") { location.hash = "#/talk/blocked"; return; }
  if (a === "rep-open") {
    repSheet(el.getAttribute("data-u"), el.getAttribute("data-n"),
             el.getAttribute("data-m"), el.getAttribute("data-b"), bare(P.id || ""));
    return;
  }
  if (a === "rep-go")  { repSend(el); return; }
  if (a === "blk-add") {
    var sbx = document.querySelector(".sheet-bg"); if (sbx) sbx.remove();
    blkAdd(el.getAttribute("data-u"), el.getAttribute("data-n")); return;
  }
  if (a === "blk-del") { blkDel(el.getAttribute("data-u")); return; }
  if (a === "saytest")   { try { trxSayTest(); } catch (e) { say("읽어주기를 부르지 못했어요"); } return; }
  if (a === "credits")   { location.hash = "#/talk/credits"; return; }
  if (a === "cd-redeem") { cdRedeem(); return; }
  if (a === "pk-make")   { pkMake(0); return; }
  if (a === "pk-copy")   { pkCopy(); return; }
  if (a === "pk-renew")  { pkRenew(); return; }
  if (a === "cd-buy")    { cdBuy(el.getAttribute("data-p")); return; }
  if (a === "cd-check")  { cdCheck(); return; }
  if (a === "wallet")  { walletSheet(el.getAttribute("data-id"), el.getAttribute("data-rn")); return; }
  if (a === "pay-w")   { walPay("wallet"); return; }
  if (a === "pay-e")   { walPay("each"); return; }
  if (a === "wal-in")  { walIn(); return; }
  if (a === "wal-out") { walOut(); return; }
  if (a === "podoya") {
    /* 이미 포도AI 탭에 있으면 주소가 안 바뀌어 아무 일도 안 일어난다.
       그래서 창 안쪽 화면에 들어가 있으면 탭을 눌러도 못 빠져나왔다.
       같은 탭을 다시 누르면 창을 새로 그려 홈으로 되돌린다. */
    if (String(location.hash || "").indexOf("#/talk/podoya") === 0) {
      /* 창을 통째로 새로 그린다. 이게 v129 에서 하던 방식이고 잘 됐다.
         한때 "신호만 보내면 다시 안 받아도 되니 빠르다" 며 바꿨다가,
         신호를 못 받는 화면에서는 홈으로 안 가고, 홈으로 가더라도 옛
         화면이 안 지워져 두 겹으로 보였다. 확실한 쪽으로 되돌린다. */
      try { renderPodoya(); } catch (e) { location.hash = "#/talk/podoya"; }
      return;
    }
    location.hash = "#/talk/podoya";
    return;
  }
  if (a === "quit") { location.hash = "#/talk/quit"; return; }
  if (a === "quit-go") {
    if (!confirm("정말 탈퇴할까요?\n\n내가 만든 방과 대화가 서버에서 지워지고,\n이 폰에 저장된 자료도 모두 사라집니다.\n되돌릴 수 없습니다.")) return;
    if (!confirm("한 번 더 확인합니다.\n\n지금 지우면 되돌릴 수 없습니다. 계속할까요?")) return;
    quitAll(); return;
  }
  if (a === "calllog") {
    /* 주소를 바꿔서 들어간다. 그러면 폰의 뒤로가기가 바로 앞 화면(설정)으로
       돌아온다. 예전에는 화면만 갈아끼워서 뒤로가기가 엉뚱한 데로 갔다. */
    location.hash = "#/talk/calllog/" + (el.getAttribute("data-k") || "log");
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
    /* 서버 주소는 띄우지 않는다. 비밀은 아니지만(앱 파일 안에 들어 있다)
       쓰는 분이 고칠 일이 없는 값이고, 화면에 보이면 눌러보거나 옮겨 적게 된다.
       확인에 필요한 것은 '닿았는가' 뿐이다. */
    var lines = ["인터넷 · " + ((navigator.onLine === false) ? "끊김 ❌" : "연결됨 ✅"),
                 "확인하는 중…"];
    w(lines.join("\n"));

    /* ① 그냥 열어보기 (CORS 검사 없음) */
    fetch(base + "/health", { mode: "no-cors" }).then(function () {
      lines[1] = "서버까지 닿음 ✅";
    })["catch"](function (e) {
      lines[1] = "서버까지 못 닿음 ❌ (" + (e && e.message ? e.message : "원인 불명") + ")";
    }).then(function () {
      /* ② 앱이 쓰는 방식 그대로 (CORS 검사 포함) */
      w(lines.join("\n") + "\n앱 방식으로 확인 중…");
      return fetch(base + "/health", { headers: { "Content-Type": "application/json" } })
        .then(function (r) { return r.text().then(function (t) {
          lines[2] = "앱 방식 · " + r.status + " " + (t.indexOf('"ok":true') >= 0 ? "정상 ✅" : "응답 이상 ⚠️");
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
    else {
      /* 주소만 치고 들어오면 포도AI 를 먼저 보여준다.
         주소도 #/talk/podoya 로 맞춰 둬야 새로고침해도 같은 화면이 나온다. */
      try { history.replaceState(null, "", "#/talk/podoya"); } catch (e2) {}
      window.renderTalk("podoya", null);
    }
  } catch (e) {}
})();

/* index.html 이 먼저 그려놓은 옛 화면이 0.2~0.5초 스쳐 보이던 것을 막는다.
   index.html 이 <html> 에 pt2-boot 을 붙여 화면을 감춰두고, 여기서 다 그린
   뒤에 떼어낸다. 이 파일이 안 실려도 index.html 쪽 시간제한이 대신 떼어낸다. */
try { document.documentElement.classList.remove("pt2-boot"); } catch (e) {}

/* ── 뒤로가기 ──
   포도AI 탭은 포도야를 '창(iframe)' 으로 띄운다. 창 안에서 화면을 열 때
   창이 스스로 방문기록을 쌓으면 그게 포도톡 전체의 기록에 섞여서,
   뒤로가기를 눌러도 밖으로 못 나가거나 엉뚱한 데로 갔다.

   그렇다고 창 안에서 기록을 아예 안 쌓으면, 이번엔 뒤로가기가 창 안
   화면을 안 닫고 포도톡을 뒤로 보낸다. 그것도 엉뚱하기는 마찬가지다.

   그래서 이렇게 나눈다.
     · 창 안에서 화면이 열리면 → 창이 부모에게 알린다 → 부모가 기록을 쌓는다
     · 뒤로가기가 오면 → 부모가 창에게 "한 겹 닫아라" 라고 알린다
   기록은 부모 한 곳에만 쌓이고, 닫는 일은 창이 한다. 서로 밟지 않는다.

   ★ 여기서 화면을 강제로 옮기지 않는다. 예전에 그렇게 했다가
     설정 안쪽을 누를 때마다 포도AI 로 튀었다. 크롬은 주소가 바뀔 때도
     popstate 를 부르기 때문이다. */
var aiDepth = 0;                 /* 창 안에 열려 있는 화면 겹 수 */
var aiMark = false;              /* 뒤로가기를 받아낼 자리를 깔아뒀는지 */

/* ── 방문기록은 딱 한 칸만 쓴다 ──
   전에는 창 안 화면이 열릴 때마다 한 칸씩 쌓았다. 포도야에서 화면을
   서너 개 열면 포도톡 기록에 포도AI 자리가 서너 개 끼어든다.
   그 뒤 다른 탭에서 화면이 닫히며 뒤로가기가 불리면, 끼어든 그 자리로
   떨어져 느닷없이 포도AI 가 떴다.

   그래서 겹이 몇이든 자리는 하나만 깐다. 뒤로가기가 오면 그 자리를
   쓰고, 아직 닫을 화면이 남아 있으면 다시 하나만 깐다.
   포도AI 탭을 떠나면 더 깔지 않는다 — 남은 한 칸은 평범한 기록 하나라
   해가 없다. */
function aiPad() {
  if (aiMark) return;
  try { history.pushState({ pt2: "ai" }, ""); aiMark = true; } catch (e) {}
}
function aiOnPodoyaTab() {
  return String(location.hash || "").indexOf("#/talk/podoya") === 0;
}

window.addEventListener("message", function (ev) {
  try {
    if (String(ev.origin || "").indexOf("podoya.ai.kr") < 0) return;
    var d = ev.data;
    if (!d || d.podoya !== "push") return;
    if (!aiOnPodoyaTab()) return;          /* 그 탭을 보고 있을 때만 */
    aiDepth++;
    aiPad();
  } catch (e) {}
});

window.addEventListener("popstate", function () {
  if (!aiMark) return;                     /* 우리가 깐 자리가 아니다 */
  aiMark = false;
  if (aiDepth <= 0) return;
  if (!aiOnPodoyaTab()) { aiDepth = 0; return; }
  aiDepth--;
  try {
    var f = document.getElementById("pt2-aif");
    if (f && f.contentWindow) {
      f.contentWindow.postMessage({ podoya: "back" }, "https://podoya.ai.kr");
    }
  } catch (e) {}
  if (aiDepth > 0) aiPad();                /* 아직 닫을 게 남았으면 한 칸만 다시 */
});

/* 화면을 다 그린 뒤에 문을 덮는다. 먼저 덮으면 뒤에서 그리는 동안
   빈 화면이 스쳐 보인다. */
try { gateCheck(); } catch (e) {}

/* 켜져 있으면 목록을 미리 한 번 받아둔다 */
try { fixTabbar(); } catch (e) {}
window.addEventListener("hashchange", function () { try { fixTabbar(); } catch (e) {} });

if (STEP >= 2 && on()) { try { refreshRooms(); } catch (e) {} }

/* 차단 목록과 내 제한 상태를 미리 받아둔다 */
try { blkLoad(); } catch (e) {}
/* 안드로이드는 getVoices() 를 한 번 불러야 목록이 채워집니다.
   미리 깨워두면 처음 듣기를 눌렀을 때 조용한 일이 줄어듭니다. */
try {
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", function () {
      try { window.speechSynthesis.getVoices(); } catch (e) {}
    });
  }
} catch (e) {}
try { setTimeout(banCheck, 1200); } catch (e) {}

})();
