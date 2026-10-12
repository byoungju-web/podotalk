/* ══════════════════════════════════════════════════════════════════════
   포도톡 API · Cloudflare Worker
   바인딩: DB(D1), AI(Workers AI)
   변수  : ALLOW_ORIGIN, PUSH_SUBJECT
   시크릿: TOKEN_SECRET, ADMIN_KEY, VAPID_PUBLIC, VAPID_PRIVATE, LINK_KEY
   ══════════════════════════════════════════════════════════════════════ */

const TE = new TextEncoder();
const TD = new TextDecoder();

const MSG_MAX = 2000;
const RATE_PER_MIN = 25;          // 유저당 분당 메시지 상한
const BOT_MAX_PER_MSG = 2;        // 한 메시지에서 호출 가능한 봇 수
const CTX_MSGS = 20;              // 봇에게 넘길 최근 대화 수

/* ── 응답 헬퍼 ────────────────────────────────────────────── */

/* 우리 서비스 주소들. ALLOW_ORIGIN 에 무엇이 적혀 있든 이 주소들은 늘 통과한다.
   포도야·포도랑은 도메인이 달라서, 이 목록에서 빠지면 앱에서만
   "서버에 닿지 못했어요" 가 뜬다. 주소창으로는 열리기 때문에 원인을
   찾기가 아주 어렵다. */
const ORIGINS_OK = [
  "https://podotalk.kr", "https://www.podotalk.kr",
  "https://podoya.ai.kr", "https://www.podoya.ai.kr",
  "https://podolang.kr", "https://www.podolang.kr",
  "https://pododa.kr", "https://www.pododa.kr",
];

function cors(env) {
  /* 브라우저는 이 값을 글자 하나까지 맞춰본다. 붙여넣을 때 끝에 공백이나
     줄바꿈이 하나 붙으면 화면에는 안 보이는데 검사는 실패한다. 그래서
     앞뒤를 잘라낸다. 쉼표로 여러 주소를 적어도 된다. */
  var raw = String(env.ALLOW_ORIGIN == null ? "" : env.ALLOW_ORIGIN);
  var list = raw.split(",")
    .map(function (x) { return x.trim().replace(/\/+$/, ""); })
    .filter(Boolean)
    .concat(ORIGINS_OK);
  var o = String(env.__origin || "").trim().replace(/\/+$/, "");
  /* 여러 주소를 허용해도 브라우저에는 하나만 돌려줄 수 있다. 그래서 목록의
     '첫 번째' 가 아니라 '지금 요청한 그 주소' 를 돌려준다. 전에는 늘 첫
     번째를 돌려줘서, ALLOW_ORIGIN 에 적어두어도 두 번째부터는 막혔다. */
  var hit = list.indexOf(o) >= 0 ? o : (list[0] || "*");
  return {
    "Access-Control-Allow-Origin": hit,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (d, env, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(env) },
  });
const bad = (m, env, s = 400) => json({ ok: false, error: m }, env, s);

/* ── 바이트 유틸 ──────────────────────────────────────────── */
function b64uToBytes(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function bytesToB64u(b) {
  const a = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ── 토큰 (방장 권한) ─────────────────────────────────────── */
async function hmacB64u(secret, msg) {
  const k = await crypto.subtle.importKey("raw", TE.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToB64u(await crypto.subtle.sign("HMAC", k, TE.encode(msg)));
}
async function issueToken(env, roomId, uid) {
  const body = bytesToB64u(TE.encode(JSON.stringify({ r: roomId, u: uid, exp: Date.now() + 180 * 86400e3 })));
  return body + "." + (await hmacB64u(env.TOKEN_SECRET || "podotalk-dev", body));
}

/* ── 사람 하나를 가리키는 토큰 ──
   방 토큰과 같은 열쇠(TOKEN_SECRET)로 서명한다.
   포도야가 크레딧을 깎을 때 "이게 누구 것이냐" 를 이걸로 증명한다.
   uid 를 그냥 믿으면 안 된다. uid 는 /talk/room/members 에 그대로
   나오므로, 같은 방에 있는 사람이 남의 크레딧을 태울 수 있다. */
async function issueUserToken(env, uid) {
  const b = bytesToB64u(TE.encode(JSON.stringify({ u: uid, exp: Date.now() + 180 * 86400e3 })));
  return b + "." + (await hmacB64u(env.TOKEN_SECRET || "podotalk-dev", b));
}
async function readUserToken(env, t) {
  if (!t || String(t).indexOf(".") < 0) return null;
  const parts = String(t).split(".");
  if (!timingSafeEq(parts[1], await hmacB64u(env.TOKEN_SECRET || "podotalk-dev", parts[0]))) return null;
  try {
    const p = JSON.parse(TD.decode(b64uToBytes(parts[0])));
    if (!p.u || !uidOk(p.u)) return null;
    return p.exp && Date.now() > p.exp ? null : p;
  } catch (e) { return null; }
}

/* 계정 열쇠 — PODO-XXXX-XXXX.
   충전 코드는 PODOxxxxxxxxxxxx (대시 없음) 이다. 일부러 모양을 다르게
   둔다. 두 칸에 서로 바꿔 넣는 일이 반드시 생기기 때문이다. */
function accountKey() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) s += A[r[i] % A.length];
  return "PODO-" + s.slice(0, 4) + "-" + s.slice(4);
}

async function readToken(env, req) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t || !t.includes(".")) return null;
  const [body, sig] = t.split(".");
  if (!timingSafeEq(sig, await hmacB64u(env.TOKEN_SECRET || "podotalk-dev", body))) return null;
  try {
    const p = JSON.parse(TD.decode(b64uToBytes(body)));
    return p.exp && Date.now() > p.exp ? null : p;
  } catch { return null; }
}
const isAdmin = (req, env) =>
  !!env.ADMIN_KEY && timingSafeEq(req.headers.get("X-Admin-Key") || "", env.ADMIN_KEY);

/* ── 입력 정리 ────────────────────────────────────────────── */
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, n);
const uidOk = (v) => /^[a-zA-Z0-9_-]{6,64}$/.test(v || "");
function roomCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) s += A[r[i] % A.length];
  return s;
}

/* ══ 웹푸시 (RFC 8291 aes128gcm + VAPID) ═══════════════════ */
async function hmacRaw(keyBytes, data) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function hkdf(salt, ikm, info, len) {
  const prk = await hmacRaw(salt, ikm);
  const out = await hmacRaw(prk, concat(info, new Uint8Array([1])));
  return out.slice(0, len);
}
async function encryptPush(p256dh, auth, payloadStr) {
  const ua = b64uToBytes(p256dh);            // 65 bytes
  const authSecret = b64uToBytes(auth);      // 16 bytes
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, kp.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(TE.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, TE.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, TE.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plain = concat(TE.encode(payloadStr), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidAuth(env, endpoint) {
  const pub = b64uToBytes(env.VAPID_PUBLIC);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: bytesToB64u(b64uToBytes(env.VAPID_PRIVATE)),
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = bytesToB64u(TE.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(TE.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: env.PUSH_SUBJECT || "mailto:hasin5jk@gmail.com",
  })));
  const unsigned = head + "." + payload;
  const sig = bytesToB64u(new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, TE.encode(unsigned))
  ));
  return `vapid t=${unsigned}.${sig}, k=${bytesToB64u(pub)}`;
}
async function pushTo(env, sub, payload) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return;
  try {
    const body = await encryptPush(sub.p256dh, sub.auth, JSON.stringify(payload));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuth(env, sub.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body,
    });
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare(`DELETE FROM pt_subs WHERE endpoint=?`).bind(sub.endpoint).run();
    }
  } catch { /* 개별 실패는 무시 */ }
}
async function notifyRoom(env, roomId, senderUid, payload) {
  if (!env.VAPID_PUBLIC) return;
  const rows = await env.DB.prepare(
    `SELECT s.endpoint,s.p256dh,s.auth FROM pt_subs s
     JOIN pt_members m ON m.uid = s.uid
     WHERE m.room_id=? AND s.uid<>? LIMIT 200`
  ).bind(roomId, senderUid || "").all();
  await Promise.all((rows.results || []).map((s) => pushTo(env, s, payload)));
}

/* ══ 기본 봇 ═══════════════════════════════════════════════
   전에는 /seed 를 손으로 한 번 눌러야 봇이 바뀌었다. 폰만 쓰는 환경에서
   POST 요청을 보내는 건 번거로운 일이라, 목록을 부를 때 워커가 알아서
   맞추도록 했다. BOT_VER 을 올리면 다음 목록 조회 때 한 번만 정리된다. */
const BOT_VER = "3";
const BOT_DEFS = [
  ["summary", "internal:summary", "general", "대화를 3줄로 요약하고 할 일을 뽑습니다", "📝"],
  ["reply", "internal:reply", "general", "손님에게 보낼 답장 초안 3가지를 씁니다", "💬"],
  ["notice", "internal:notice", "general", "대충 적은 내용을 손님용 안내문으로 다듬습니다", "📢"],
  ["fix", "internal:fix", "general", "맞춤법을 고치고 정중한 말투로 다듬습니다", "✏️"],
  ["translate", "internal:translate", "general", "한국어 ↔ 영어로 번역합니다", "🌏"],
  ["idea", "internal:idea", "creator", "아이디어 5개를 각도별로 제안합니다", "💡"],
];

async function syncBots(env) {
  /* 이미 이 판으로 맞춰져 있으면 아무것도 하지 않는다 */
  const mark = "__botver_" + BOT_VER;
  const done = await env.DB.prepare(`SELECT id FROM pt_mcp WHERE name=?`).bind(mark).first();
  if (done) return;

  const keep = BOT_DEFS.map((d) => d[0]);
  /* 물러난 기본 봇과 옛 표식을 한꺼번에 지운다. 표식도 url 이 internal: 로
     시작하므로 이 한 줄에 같이 걸린다. 직접 등록한 봇은 건드리지 않는다.
     (전에 여기에 ESCAPE '\' 를 썼다가 자바스크립트가 역슬래시를 먹어
      잘못된 SQL 이 되는 바람에 봇이 갱신되지 않았다.) */
  await env.DB.prepare(
    `DELETE FROM pt_mcp WHERE url LIKE 'internal:%' AND name NOT IN (${keep.map(() => "?").join(",")})`
  ).bind(...keep).run();

  for (const [name, u, type, descr, icon] of BOT_DEFS) {
    await env.DB.prepare(
      `INSERT INTO pt_mcp(id,name,url,type,descr,icon,enabled,created) VALUES(?,?,?,?,?,?,1,?)
       ON CONFLICT(name) DO UPDATE SET url=excluded.url,descr=excluded.descr,icon=excluded.icon,enabled=1`
    ).bind(crypto.randomUUID(), name, u, type, descr, icon, Date.now()).run();
  }
  /* 다 됐다는 표식. enabled=0 이라 목록에는 안 나온다. */
  await env.DB.prepare(
    `INSERT OR IGNORE INTO pt_mcp(id,name,url,type,descr,icon,enabled,created)
     VALUES(?,?,?,?,?,?,0,?)`
  ).bind(crypto.randomUUID(), mark, "internal:mark", "general", "", "", Date.now()).run();
}

/* ══ 봇 실행 ═══════════════════════════════════════════════ */
const INTERNAL = {
  summary: "너는 포도톡의 요약봇이다. 아래 대화를 한국어로 3줄 이내 요약하고, 이어서 '할 일:' 목록을 최대 4개 뽑아라. 대화에 없는 내용은 만들어내지 마라.",
  translate: "너는 번역봇이다. 사용자가 준 문장을 자연스러운 영어로 번역만 출력하라. 이미 영어면 한국어로 번역하라. 설명은 붙이지 마라.",
  idea: "너는 아이디어봇이다. 사용자의 요청에 대해 서로 다른 각도의 아이디어 5개를 한 줄씩 제시하라. 마지막에 가장 실행이 빠른 것 하나를 골라 이유 한 줄을 붙여라.",

  /* 사장님이 실제로 하루에 몇 번씩 하는 일로 바꿨다.
     퀴즈·가게찾기는 채팅방에서 쓸 일이 거의 없었다. */
  reply: "너는 답장 도우미다. 아래는 손님이나 거래처가 보낸 말이다. 보낼 답장 초안을 3가지로 써라. " +
    "① 정중하게 ② 짧고 간단하게 ③ 정중히 거절하거나 미루는 경우. " +
    "각각 두세 문장을 넘기지 말고, 번호와 짧은 이름만 붙여 바로 복사해 쓸 수 있게 하라. 설명은 붙이지 마라.",
  notice: "너는 안내문 도우미다. 사용자가 대충 적은 내용을 손님에게 그대로 보낼 수 있는 안내문으로 다듬어라. " +
    "존댓말로, 날짜·시간·장소·연락처가 있으면 눈에 띄게 정리하고, 없는 내용은 지어내지 마라. " +
    "다섯 줄을 넘기지 말고 안내문만 출력하라.",
  fix: "너는 맞춤법 도우미다. 사용자가 쓴 글의 맞춤법과 띄어쓰기를 고치고, 손님에게 보내도 될 만큼 정중한 말투로 다듬어라. " +
    "뜻은 바꾸지 말고, 고친 글만 출력하라. 설명은 붙이지 마라.",
};

function safeExternalUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] === 169 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168)) return null;
  }
  if (h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd")) return null;
  return u.toString();
}

/* 모델은 예고 없이 단종되므로 순서대로 시도한다.
   env.AI_MODEL 을 넣으면 그 모델을 맨 앞에서 먼저 쓴다. */
const AI_MODELS = [
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-3b-instruct",
];
/* 짧은 답이면 되는 작업은 작은 모델부터 — 훨씬 빠르다 */
const AI_MODELS_FAST = [
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/google/gemma-4-26b-a4b-it",
];
const RETRY_NEXT = /deprecat|not found|no such model|unsupported|5028|404/i;

/* 쓰는 분이 직접 넣은 키로 부른다.
   봇을 우리 돈으로 돌리면 사람이 늘수록 그대로 손해가 된다. 키를 넣은
   분은 자기 키로 마음껏 쓰고, 안 넣은 분은 하루 몇 번만 우리 것으로 쓴다. */
/* 모델은 예고 없이 단종된다. Gemini 2.5 계열은 2026년 10월 16일에 끝난다.
   그래서 이름을 하나로 못박지 않고 순서대로 시도한다. 앞의 것이 없어지면
   자동으로 다음 것을 쓴다. 값이 싼 것부터 적어둔다. */
const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];
const GONE = /not found|not supported|unsupported|deprecat|404|invalid model/i;

async function callGemini(key, system, user, max) {
  let last = "";
  for (const m of GEMINI_MODELS) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + m +
        ":generateContent?key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: max || 600 }
          }) });
      const j = await r.json();
      const t = j?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "";
      if (t) return String(t).trim();
      last = (j && j.error && j.error.message) || "";
      if (!GONE.test(last)) break;        /* 모델 탓이 아니면 다음 것도 마찬가지다 */
    } catch (e) { last = (e && e.message) || ""; }
  }
  return "";
}

async function runUserAI(key, provider, system, user, max) {
  try {
    if (provider === "gemini") return await callGemini(key, system, user, max);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: max || 600,
        system, messages: [{ role: "user", content: user }]
      })
    });
    const j = await r.json();
    const t = (j?.content || []).map((x) => x.text || "").join("");
    return String(t).trim();
  } catch (e) { return ""; }
}

async function runAI(env, system, user, opts = {}) {
  /* ① 쓰는 분이 자기 키를 넣었으면 그것부터 쓴다 (값이 안 든다) */
  if (opts.userKey) {
    const t = await runUserAI(opts.userKey, opts.provider, system, user, opts.max);
    if (t) return t;
  }
  /* ② 크레딧을 먼저 깎았다면 우리 키로 부른다 */
  if (opts.managed && env.GEMINI_KEY) {
    const t = await callGemini(env.GEMINI_KEY, system, user, opts.max);
    if (t) return t;
  }
  /* ③ 그 다음이 Workers AI */
  if (!env.AI) return "AI 바인딩이 연결되어 있지 않습니다. Worker 설정에서 Workers AI를 추가해 주세요.";
  const base = opts.fast ? AI_MODELS_FAST : AI_MODELS;
  const models = env.AI_MODEL ? [env.AI_MODEL, ...base] : base;
  let lastErr = "";
  for (const m of models) {
    try {
      const r = await env.AI.run(m, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: opts.max || 500,
      });
      let out = (r && (r.response || r.result || r.output_text)) || "";
      if (typeof out !== "string") out = JSON.stringify(out);
      out = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (out) return out;
      lastErr = "빈 응답";
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      if (!RETRY_NEXT.test(lastErr)) break;
    }
  }
  return `AI 응답을 받지 못했습니다. (${lastErr.slice(0, 200)})`;
}

/* 전용 번역 모델 — LLM보다 빠르고 정확하다 */
async function translate(env, text) {
  const src = /[가-힣]/.test(text) ? "korean" : "english";
  const tgt = src === "korean" ? "english" : "korean";
  try {
    const r = await env.AI.run("@cf/meta/m2m100-1.2b", { text, source_lang: src, target_lang: tgt });
    const out = (r && (r.translated_text || r.response)) || "";
    if (out) return out;
  } catch (e) {
    if (!RETRY_NEXT.test((e && e.message) || "")) return `번역에 실패했습니다. (${e.message})`;
  }
  // 번역 모델이 없으면 일반 모델로 대체
  return await runAI(env, `다음 문장을 ${tgt === "english" ? "영어" : "한국어"}로 번역만 해라. 설명이나 따옴표는 붙이지 마라.`, text, { fast: true, max: 300 });
}

async function callBot(env, spec, userText, context, ai) {
  try {
    // 크리에이터가 만든 커스텀 봇
    if (spec.kind === "agent") {
      return await runAI(env, `${spec.prompt || "친절한 도우미"}\n\n[최근 대화]\n${context}`, userText, ai || {});
    }
    // 내장 봇
    if (spec.url.startsWith("internal:")) {
      const t = spec.url.slice(9);
      if (t === "shopping") {
        const q = userText.replace(/@[a-z0-9_-]+/gi, "").trim().slice(0, 30);
        const rows = await env.DB.prepare(
          `SELECT slug,name,emoji,cat,area FROM store_meta
           WHERE paused=0 AND (name LIKE ?1 OR cat LIKE ?1 OR area LIKE ?1)
           ORDER BY updated DESC LIMIT 5`
        ).bind(`%${q}%`).all();
        const list = rows.results || [];
        if (!list.length) return `'${q}'에 맞는 가게를 못 찾았습니다. 다른 이름이나 동네로 다시 불러주세요.`;
        return "포도다에서 찾은 가게입니다.\n" +
          list.map((s) => `${s.emoji || "🍇"} ${s.name} · ${s.cat || ""} ${s.area || ""}\nhttps://pododa.kr/#/${s.slug}`).join("\n\n");
      }
      const sys = INTERNAL[t];
      if (!sys) return "아직 준비되지 않은 봇입니다.";
      if (t === "translate") return await translate(env, userText.replace(/@[a-z0-9_-]+/gi, "").trim());
      const needCtx = t === "summary" || t === "quiz";
      return await runAI(env, needCtx ? `${sys}\n\n[대화]\n${context}` : sys, userText,
        Object.assign({ fast: t === "idea" ? false : needCtx ? false : true,
                        max: needCtx ? 600 : 450 }, ai || {}));
    }
    // 외부 MCP 서버
    const url = safeExternalUrl(spec.url);
    if (!url) return "이 봇의 주소를 사용할 수 없습니다. 관리자에게 알려주세요.";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: spec.name, arguments: { query: userText, context: context.slice(-2000) } },
      }),
    });
    const text = (await res.text()).slice(0, 4000);
    try {
      const j = JSON.parse(text);
      const c = j?.result?.content;
      if (Array.isArray(c)) return c.map((x) => x.text || "").join("\n").slice(0, 3000) || text;
      return (j?.result?.text || text).slice(0, 3000);
    } catch { return text; }
  } catch (e) {
    return `봇 응답에 실패했습니다. (${e.name === "TimeoutError" ? "응답 시간 초과" : e.message})`;
  }
}

async function resolveMentions(env, roomId, names) {
  const out = [];
  const ph = names.map(() => "?").join(",");
  const mcp = await env.DB.prepare(
    `SELECT name,url,icon FROM pt_mcp WHERE enabled=1 AND name IN (${ph})`
  ).bind(...names).all();
  for (const m of mcp.results || []) out.push({ kind: "mcp", name: m.name, url: m.url, icon: m.icon || "🤖" });

  const found = new Set(out.map((o) => o.name));
  const rest = names.filter((n) => !found.has(n));
  if (rest.length) {
    const ph2 = rest.map(() => "?").join(",");
    const ag = await env.DB.prepare(
      `SELECT name,prompt,icon FROM pt_agents WHERE room_id=? AND name IN (${ph2})`
    ).bind(roomId, ...rest).all();
    for (const a of ag.results || []) out.push({ kind: "agent", name: a.name, prompt: a.prompt, icon: a.icon || "✨" });
  }
  return out.slice(0, BOT_MAX_PER_MSG);
}

async function runBotsAndSave(env, roomId, specs, userText, context, ai) {
  for (const spec of specs) {
    let text = clean(await callBot(env, spec, userText, context, ai), 4000);
    /* 답을 못 받았으면 깎았던 크레딧을 도로 넣어준다.
       돈만 나가고 아무것도 못 받는 일이 있으면 안 된다. */
    if (!text || /^AI 응답을 받지|^봇 응답에 실패/.test(text)) {
      if (ai && ai.managed && ai.uid && ai.cost) {
        try { await cdGive(env, ai.uid, ai.cost, "ai-refund"); } catch (e) {}
      }
      text = text || "답을 받지 못했어요. 잠시 뒤 다시 불러주세요.";
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO pt_messages(id,room_id,uid,nick,body,kind,meta,created) VALUES(?,?,?,?,?,'bot',?,?)`)
        .bind(id, roomId, `bot:${spec.name}`, spec.name, text, JSON.stringify({ icon: spec.icon, kind: spec.kind }), now),
      env.DB.prepare(`UPDATE pt_rooms SET msg_count=msg_count+1,last_body=?,last_nick=?,last_ts=? WHERE id=?`)
        .bind(text.slice(0, 80), `@${spec.name}`, now, roomId),
    ]);
    await notifyRoom(env, roomId, null, {
      title: `@${spec.name}`, body: text.slice(0, 120), room_id: roomId, tag: `room-${roomId}`,
    });
  }
}

/* ══ 안전장치 · 걸러내기 ═══════════════════════════════════
   앱스토어(지침 1.2)는 사람이 글을 올리는 앱에 네 가지를 요구한다.
   ① 부적절한 글 걸러내기 ② 신고 ③ 차단 ④ 신고 뒤 24시간 안의 조치.
   여기서는 ④를 사람 손이 아니라 규칙으로 즉시 처리한다.

   말을 막는 일은 조심스럽다. 그래서 두 칸으로 나눴다.
     HARD — 거래·유인 문구. 보내는 것 자체를 막고 바로 이용을 제한한다.
            "삽니다/팝니다/문의" 같은 거래 신호가 함께 있을 때만 걸린다.
            그래서 뉴스 이야기나 걱정하는 대화는 걸리지 않는다.
     SOFT — 욕설. 보내지긴 하되 ●● 로 가린다. 말을 막지는 않는다.
   두 칸 모두 이 파일 안에 있으니 언제든 늘리고 줄일 수 있다. */

/* 사이띄우기·특수문자·반복글자로 빠져나가는 것을 먼저 눌러 붙인다 */
function modNorm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s.,\-_*~`'"^+=|\\\/()\[\]{}<>!?@#$%&:;]/g, "")
    .replace(/(.)\1{2,}/g, "$1$1");
}

/* 거래·유인 신호 — 이 말이 함께 있어야 HARD 로 본다 */
const MOD_DEAL = ["삽니다","팝니다","판매","구매","문의","연락","дм","dm","오픈톡","텔레","텔레그램",
  "가격","입금","송금","선입금","후불","배송","드림","구합니다","취급","도매","총판","콜","가입",
  "추천인","코드","링크","접속","보증","환전","충전","머니","시드","수익","보장","작업","알바"];

/* 그 자체로 막는 말 (거래 신호가 없어도 HARD) */
const MOD_HARD_ALONE = [
  /* 마약 은어 */ "필로폰","히로뽕","아이스작대기","떨팝니다","케타민","엑스터시","lsd","아이스작대",
  /* 성매매 */ "조건만남","성매매","출장안마","오피","건마","키스방","안마방","실장님초이스",
  /* 아동 관련 — 어떤 맥락에서도 막는다 */ "아청","미성년물","로리물",
  /* 총기·폭발물 */ "사제총기","총기제작","사제총","폭탄제조","급조폭발"
];

/* 거래 신호와 함께 있을 때만 막는 말 */
const MOD_HARD_DEAL = [
  /* 마약 · '떨' 은 "떨어졌다" 에, '아이스' 는 "아이스 아메리카노" 에 그대로
     들어간다. '떨' 은 아래 MOD_HARD_WORD 에서 낱말일 때만 본다.
     '아이스' 는 아예 뺀다 — 커피와 구별할 방법이 없다. 마약 쪽은
     MOD_HARD_ALONE 의 "아이스작대기" 가 잡는다. */
  "마약","대마","작대기","캔디","브액","엑스터","코카인","헤로인","졸피뎀","프로포폴",
  /* 도박 */ "토토","사설토토","바카라","슬롯","홀덤","카지노","먹튀검증","배팅","베팅","환전상",
  /* 총기 */ "총기","권총","실탄","탄약","사제총","석궁",
  /* 개인정보·계정 거래 */ "명의대여","대포통장","대포폰","계정판매","해킹대행"
];

/* 짧아서 다른 말 속에 파묻히는 것들.
   여기는 눌러 붙인 글이 아니라 원문에서 본다. 앞뒤가 한글·영문·숫자가
   아닐 때만 걸린다. "가격이 떨어졌어요" 의 '떨' 은 뒤에 '어' 가 붙어 있어
   지나가고, "떨 얼마예요" 처럼 낱말로 떨어져 있을 때만 걸린다. */
const MOD_HARD_WORD = ["떨"];
function modWordHit(raw) {
  const t = String(raw || "").toLowerCase();
  for (const w of MOD_HARD_WORD) {
    if (new RegExp("(^|[^가-힣a-z0-9])" + w + "([^가-힣a-z0-9]|$)").test(t)) return w;
  }
  return "";
}

/* 욕설 — 가려서 보낸다 */
const MOD_SOFT = ["시발","씨발","씹할","좆","존나","병신","지랄","개새끼","새끼야","니미","엠창",
  "미친놈","미친년","썅","닥쳐","꺼져","등신","호구새끼","미친새끼","죽여버","패버릴","뒤져라",
  "fuck","shit","bitch","asshole"];

/* 글 하나를 살펴본다. { level, hit, text } 를 돌려준다.
     level 0 — 깨끗함
     level 1 — 욕설. text 에 가려진 글이 담긴다
     level 2 — 거래·유인. 보내지 않는다 */
function modCheck(raw) {
  const t = modNorm(raw);
  if (!t) return { level: 0, hit: "", text: raw };

  for (const w of MOD_HARD_ALONE) {
    if (t.includes(modNorm(w))) return { level: 2, hit: w, text: raw };
  }
  let deal = false;
  for (const w of MOD_DEAL) { if (t.includes(modNorm(w))) { deal = true; break; } }
  if (deal) {
    for (const w of MOD_HARD_DEAL) {
      if (t.includes(modNorm(w))) return { level: 2, hit: w, text: raw };
    }
    const ww = modWordHit(raw);
    if (ww) return { level: 2, hit: ww, text: raw };
  }

  let out = String(raw), hit = "", soft = false;
  for (const w of MOD_SOFT) {
    if (t.includes(modNorm(w))) {
      soft = true; if (!hit) hit = w;
      /* 원문에서 그 말을 찾아 가린다. 사이에 글자가 끼어 있어도 잡는다 */
      const rx = new RegExp(w.split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s.\\-_*~]{0,2}"), "gi");
      out = out.replace(rx, (m) => "●".repeat(Math.max(2, m.replace(/\s/g, "").length)));
    }
  }
  return soft ? { level: 1, hit, text: out } : { level: 0, hit: "", text: raw };
}

/* ══ 미리 번역 ═══════════════════════════════
   지금까지는 받는 사람마다 자기 폰에서 번역을 요청했다. 100명 방이면
   메시지 하나에 요청이 100번 나간다. 방이 커질수록 그대로 늘어난다.

   보내는 쪽에서 한 번만 한다. 방 안에 어떤 언어를 쓰는 사람들이 있는지
   보고, 그 언어들로만 미리 번역해 둔다. 100명이 세 나라 말을 쓰면
   세 번이면 끝난다. 사람이 몇이든 상관없다.

   번역해 둔 것은 메시지에 붙어 따라오므로 받는 폰은 아무것도 요청하지
   않는다. 아직 안 끝났으면 예전처럼 폰이 스스로 번역한다.

   표를 먼저 만들어야 한다 (d1-큰방.sql 참고) */
const PRE_LANG_MAX = 8;      /* 한 방에서 미리 번역할 언어 수 상한 */

async function preTranslate(env, roomId, msgId, text, fromLang, uid) {
  try {
    if (!text || text.length > 1000) return;

    /* 1:1 통역은 무료다. 둘이 쓰는 것이라 언어가 하나뿐이고 값이 거의 안 든다.
       크레딧을 받는 건 다중 동시통역방(👪) 뿐이다. */
    let paid = false;
    try {
      const rm0 = await env.DB.prepare(`SELECT emoji FROM pt_rooms WHERE id=?`).bind(roomId).first();
      paid = !!(rm0 && rm0.emoji === "👪");
    } catch (e) {}
    if (!paid) uid = null;                 /* 무료 방이면 아무것도 깎지 않는다 */
    const rows = await env.DB.prepare(
      `SELECT DISTINCT lang FROM pt_members WHERE room_id=? AND lang IS NOT NULL AND lang<>'' LIMIT ?`
    ).bind(roomId, PRE_LANG_MAX + 2).all();

    const src = String(fromLang || "").toLowerCase();
    const langs = (rows.results || [])
      .map((r) => String(r.lang || "").toLowerCase())
      .filter((l) => l && l !== src)
      .slice(0, PRE_LANG_MAX);
    if (!langs.length) return;

    /* ── 말한 사람이 낸다 ──
       듣기만 하는 사람은 한 푼도 안 낸다. 조용히 보고 있는데 잔액이
       줄어드는 건 쓰는 사람이 가장 싫어하는 방식이다.
       방에 세 나라 말이 있으면 한 마디에 0.3크레딧이다.
       모자라면 그만큼만 번역한다. 대화 자체는 막지 않는다. */
    let can = langs.length;
    let fromWallet = 0;                    /* 그중 방 지갑에서 나온 몫 */
    if (uid) {
      /* 방 지갑에서 먼저, 모자라면 내 것에서. 낸 만큼만 번역한다. */
      /* 1:1 이후 번역 한 줄 = CD.tr(0.1). 낸 금액을 '몇 줄' 로 바꿔 센다. */
      const trCost = Math.round(CD.tr * langs.length * 10) / 10;
      const paid = await payTake(env, roomId, uid, trCost, "tr");
      can = Math.floor(paid.got / CD.tr + 1e-6);
      fromWallet = Math.floor(paid.wallet / CD.tr + 1e-6);
      if (can <= 0) return;
    }
    let done = 0;

    for (const to of langs) {
      if (done >= can) break;
      let out = "";
      try {
        const r = await env.AI.run("@cf/meta/m2m100-1.2b",
          { text, source_lang: src || "ko", target_lang: to });
        out = String((r && (r.translated_text || r.response)) || "").trim();
      } catch (e) {}
      if (!out) {
        /* 나온 곳으로 돌려준다. 방 지갑에서 나갔으면 방 지갑으로. */
        if (uid) {
          if (fromWallet > 0) { await walletGive(env, roomId, CD.tr, "tr-refund"); fromWallet--; }
          else await cdGive(env, uid, CD.tr, "tr-refund");
        }
        can--; continue;
      }
      await env.DB.prepare(
        `INSERT OR IGNORE INTO pt_msg_tr(msg_id,lang,text,ts) VALUES(?,?,?,?)`
      ).bind(msgId, to, out.slice(0, 2000), Date.now()).run();
      done++;
    }
  } catch (e) { /* 미리 번역이 실패해도 대화는 그대로 간다 */ }
}

/* 그 사람 언어로 번역해 둔 것을 메시지에 붙여준다 */
async function attachTr(env, list, lang) {
  const to = String(lang || "").toLowerCase();
  if (!to || !list.length) return list;
  const ids = list.map((m) => m.id).filter(Boolean).slice(0, 100);
  if (!ids.length) return list;
  try {
    const r = await env.DB.prepare(
      `SELECT msg_id,text FROM pt_msg_tr WHERE lang=? AND msg_id IN (${ids.map(() => "?").join(",")})`
    ).bind(to, ...ids).all();
    const map = {};
    for (const x of (r.results || [])) map[x.msg_id] = x.text;
    for (const m of list) if (map[m.id]) m.tr = map[m.id];
  } catch (e) {}
  return list;
}

/* 방 인원 상한. 폴링이 사람 수에 정비례하므로 무한정 받을 수 없다. */
const ROOM_MAX = 100;

/* ══ 크레딧 ═══════════════════════════════════════════════
   AI 를 우리 키로 돌리기로 했다. 그러면 쓰는 만큼 우리 돈이 나간다.
   그래서 부르기 전에 먼저 깎는다. 부르고 나서 깎으면 실패한 요청으로
   얼마든지 뽑아갈 수 있다.

   값은 여기 한 곳에만 적는다. 나중에 바꿀 때 이 표만 고치면 된다.
     채팅 · 통역톡      0   (원가가 없다)
     AI 답 1회        0.1   (원가 0.5~2원)
     마주보고 통역 1분 0.3   (원가 10원)
     전화통역 1분       6   (원가 300원)
   1크레딧을 99원쯤으로 팔면 앞뒤가 맞는다.

   ai_fast · ai_good · search · stt 는 포도야(podoya-api)가 쓰는 값이다.
   깎는 일은 포도야가 /link/credits 로 부탁하고, 실제 차감은 여기서 한다.
   앱 화면의 요금표도 이 표를 그대로 받아 그린다.

   표를 먼저 만들어야 한다 (D1 콘솔) : d1-크레딧.sql 참고             */
const CD = { ai: 0.1, talk: 0.3, phone: 6, tr: 0.1,
             ai_fast: 0.2, ai_good: 0.8, search: 0.4, stt: 0.1 };

/* ══ 처음 오신 분께 드리는 체험분 ══
   ── 왜 '매일' 이 아니라 '한 번' 인가 ──
   매일 주면 쓰는 사람 수에 비례해 값이 무한히 늘어난다. 한 번만 주면
   전체 금액이 아래 두 숫자의 곱으로 딱 잠긴다. 광고비처럼 미리 셀 수
   있다. 20 × 50,000 = 100만 크레딧이 이 앱이 평생 나눠줄 전부다.

   ── 왜 구글 로그인한 사람에게만 주는가 ──
   uid 는 앱을 지웠다 깔면 새로 생긴다. uid 로 주면 지웠다 깔기를
   반복해 얼마든지 받아갈 수 있다. 구글 계정 번호(sub)는 그렇게 안 된다.

   한도에 닿으면 조용히 그만 준다. 앱은 멈추지 않는다 — 크레딧을 사면
   그대로 쓸 수 있다. */
const CD_SIGNUP = 2;
const SIGNUP_CAP = 50000;          /* 이 사람 수까지만 준다 */

/* 한 사람이 하루에 쓸 수 있는 최대치.
   청구서가 먼저 오는 일을 막는다. 잘못 도는 스크립트나 실수로 눌린
   반복 요청이 하루치에서 멈춘다. 방 지갑에 넣고 빼는 것은 세지 않는다
   (쓴 것이 아니라 옮긴 것이다). */
const CD_DAY_CAP = 30;

/* 파는 묶음. 많이 살수록 조금씩 싸진다.
   0.1크레딧 = 번역 한 줄. 값을 바꾸려면 여기만 고치면 된다. */
const CD_PACKS = [
  { id: "p1",  credits: 100,   krw: 9900,  usd: 6.9,  label: "가볍게" },
  { id: "p3",  credits: 300,   krw: 29000, usd: 20,   label: "넉넉히" },
  { id: "p5",  credits: 550,   krw: 49000, usd: 34,   label: "자주 쓰는 분", bonus: "10% 더" },
  { id: "p10", credits: 1200,  krw: 99000, usd: 69,   label: "가게·공장", bonus: "20% 더" },
];
const AI_MONTH_CAP = 30000;            /* 한 달에 우리 키로 부를 수 있는 최대 횟수 */

async function cdRow(env, uid) {
  let r = await env.DB.prepare(`SELECT balance FROM pt_credits WHERE uid=?`).bind(uid).first();
  if (!r) {
    /* 지갑만 만들어 둔다. 선물은 여기서 주지 않는다.
       uid 는 앱을 지웠다 깔면 새로 생기므로, 여기서 주면 무한정 받아갈
       수 있다. 선물은 구글 로그인을 마친 뒤 cdGift 가 한 번만 준다. */
    await env.DB.prepare(
      `INSERT OR IGNORE INTO pt_credits(uid,balance,got,used,updated) VALUES(?,0,0,0,?)`
    ).bind(uid, Date.now()).run();
    r = { balance: 0 };
  }
  return r;
}

/* ══ 가입 선물 — 구글 계정 하나에 한 번 ══
   표를 먼저 만들어야 한다 (D1 콘솔) :
     CREATE TABLE IF NOT EXISTS pt_meta (k TEXT PRIMARY KEY, v INTEGER);
     ALTER TABLE pt_accounts ADD COLUMN gift INTEGER DEFAULT 0;
   두 번째 줄은 이미 있으면 오류가 나는데, 그냥 넘어가면 된다.       */
async function cdGift(env, sub, uid) {
  try {
    /* 이미 받은 계정인가 */
    const a = await env.DB.prepare(`SELECT gift FROM pt_accounts WHERE sub=?`).bind(sub).first();
    if (a && a.gift) return { given: 0, reason: "already" };

    /* 몇 명까지 줬는가. 한 줄을 조건부로 올려서, 동시에 여러 명이
       들어와도 한도를 넘지 않게 한다. */
    await env.DB.prepare(`INSERT OR IGNORE INTO pt_meta(k,v) VALUES('signup_n',0)`).run();
    const up = await env.DB.prepare(
      `UPDATE pt_meta SET v=v+1 WHERE k='signup_n' AND v<?`
    ).bind(SIGNUP_CAP).run();
    if (!(up.meta && up.meta.changes)) return { given: 0, reason: "cap" };

    await env.DB.prepare(`UPDATE pt_accounts SET gift=1 WHERE sub=?`).bind(sub).run();
    await cdGive(env, uid, CD_SIGNUP, "signup");
    return { given: CD_SIGNUP, reason: "ok" };
  } catch (e) { return { given: 0, reason: "error" }; }
}

/* 오늘 이 사람이 얼마나 썼는가. 상한을 넘으면 더 못 쓴다. */
async function cdDaySpent(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const r = await env.DB.prepare(`SELECT n FROM pt_day WHERE uid=? AND day=?`)
      .bind(uid, day).first();
    return (r && r.n) || 0;
  } catch (e) { return 0; }        /* 표가 아직 없으면 막지 않는다 */
}
async function cdDayAdd(env, uid, n) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `INSERT INTO pt_day(uid,day,n) VALUES(?,?,?)
       ON CONFLICT(uid,day) DO UPDATE SET n = pt_day.n + excluded.n`
    ).bind(uid, day, n).run();
  } catch (e) {}
}

/* ══ 방 지갑에서 먼저 꺼낸다 ══
   사장이 방에 넣어둔 몫이 있으면 거기서 먼저 쓴다. 직원은 자기 크레딧이
   없어도 말할 수 있다. 방 지갑이 비면 그때 자기 것에서 나간다.
   둘 다 없으면 번역만 안 되고 말은 그대로 간다. */
async function payTake(env, roomId, uid, cost, kind) {
  if (!cost) return { got: 0, wallet: 0 };
  let got = 0;
  /* 방을 만들 때 누가 낼지 정한다.
       wallet — 방장이 방 지갑에 넣어둔 것으로 다 같이 쓴다 (공장·교회처럼
                한 사람이 대신 내는 자리)
       each   — 참석한 사람이 각자 자기 크레딧으로 낸다 (친구·모임처럼
                굳이 한 사람이 다 낼 이유가 없는 자리)
     정한 것이 없으면 예전처럼 지갑을 먼저 본다. */
  let useWallet = false;
  if (roomId) {
    try {
      const w = await env.DB.prepare(`SELECT pay FROM pt_wallets WHERE room_id=?`).bind(roomId).first();
      useWallet = !w || w.pay !== "each";
    } catch (e) { useWallet = true; }
  }
  if (useWallet) {
    const r = await env.DB.prepare(
      `UPDATE pt_wallets SET balance=balance-?, used=used+?, updated=?
        WHERE room_id=? AND balance>=?`
    ).bind(cost, cost, Date.now(), roomId, cost).run();
    if (r.meta && r.meta.changes) return { got: cost, wallet: cost };  /* 방 지갑으로 다 냈다 */

    /* 모자라면 남은 것만 긁어 쓴다 */
    const w = await env.DB.prepare(`SELECT balance FROM pt_wallets WHERE room_id=?`)
      .bind(roomId).first();
    const have = Math.max(0, (w && w.balance) || 0);
    if (have > 0) {
      const r2 = await env.DB.prepare(
        `UPDATE pt_wallets SET balance=balance-?, used=used+?, updated=?
          WHERE room_id=? AND balance>=?`
      ).bind(have, have, Date.now(), roomId, have).run();
      if (r2.meta && r2.meta.changes) got = have;
    }
  }
  const wallet = got;                    /* 여기까지가 방 지갑에서 나온 몫이다 */
  const rest = cost - got;
  if (rest > 0 && uid && await cdTake(env, uid, rest, kind)) got += rest;
  return { got, wallet };
}

/* 방 지갑에 도로 넣는다. 방 지갑에서 나간 몫은 방 지갑으로 돌아가야 한다.
   개인에게 넣어주면 방장이 넣어둔 크레딧이 조금씩 개인에게 새어 나간다. */
async function walletGive(env, roomId, amount, kind) {
  if (!amount || !roomId) return;
  try {
    await env.DB.prepare(
      `UPDATE pt_wallets SET balance=balance+?, used=MAX(0,used-?), updated=? WHERE room_id=?`
    ).bind(amount, amount, Date.now(), roomId).run();
  } catch (e) {}
}

/* 잔액만 본다. 없는 사람은 표에 만들면서 체험분을 넣어준다. */
async function cdBalance(env, uid) {
  const r = await cdRow(env, uid);
  return (r && r.balance) || 0;
}

/* ══ coverfo 지갑 연결 (v76) ══════════════════════════════
   coverfo.com 에서 충전한 크레딧을 포도톡에서도 쓴다.
     · 포도톡 크레딧 1 = coverfo 크레딧 1 (1:1 · 같은 금액)
     · 연결한 사람은 "포도톡에 남은 크레딧을 먼저" 쓰고, 다 쓰면 coverfo 지갑에서 나간다.
       그래서 예전 잔액이 묶이지 않고, 돌려주기(번역 실패 등)는 늘 포도톡 쪽으로 들어온다.
     · coverfo 에는 늘 item:"pt", qty:크레딧 으로 보낸다 → coverfo 가 그대로 깎는다.
   표 pt_cflink 는 처음 쓸 때 저절로 만든다 (D1 콘솔에서 따로 할 일 없음).
   바꾸고 싶으면 변수 CF_WALLET_URL (기본 https://coverfo.com/api/wallet). */
const CF_WALLET_URL = "https://coverfo.com/api/wallet";
let CFL_READY = false;
async function cflReady(env) {
  if (CFL_READY) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS pt_cflink (uid TEXT PRIMARY KEY, code TEXT NOT NULL, ts INTEGER)`
    ).run();
  } catch (e) {}
  CFL_READY = true;
}
async function cflCode(env, uid) {
  if (!uid) return "";
  await cflReady(env);
  try {
    const r = await env.DB.prepare(`SELECT code FROM pt_cflink WHERE uid=?`).bind(uid).first();
    return (r && r.code) || "";
  } catch (e) { return ""; }
}
async function cfCall(env, body) {
  try {
    const r = await fetch(env.CF_WALLET_URL || CF_WALLET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ source: "podotalk" }, body)),
    });
    let j = null;
    try { j = await r.json(); } catch (e) {}
    return { status: r.status, j: j || {} };
  } catch (e) { return { status: 0, j: {} }; }
}
/* coverfo 잔액을 포도톡 크레딧으로 (1:1 · 모르면 0) */
async function cfPt(env, code) {
  if (!code) return 0;
  const r = await cfCall(env, { op: "balance", code });
  if (r.status !== 200 || !r.j.ok) return 0;
  return Math.max(0, Math.floor(Number(r.j.paid || 0) + 1e-6));
}
/* coverfo 에서 포도톡 크레딧 n 만큼 깎기 → 성공 true */
async function cfSpend(env, code, n, kind) {
  if (!code || !n) return false;
  const r = await cfCall(env, {
    op: "spend", code, item: "pt", qty: n,
    ref: "pt-" + crypto.randomUUID(), note: String(kind || "").slice(0, 60),
  });
  return r.status === 200 && !!r.j.ok;
}
/* 쓸 수 있는 전체 = 포도톡 잔액 + (연결했으면) coverfo 잔액 (1:1) */
async function payBalance(env, uid) {
  const own = await cdBalance(env, uid);
  const code = await cflCode(env, uid);
  return own + (code ? await cfPt(env, code) : 0);
}
async function cdLog(env, uid, delta, kind) {
  try {
    await env.DB.prepare(
      `INSERT INTO pt_credit_log(id,uid,delta,kind,ts) VALUES(?,?,?,?,?)`
    ).bind(crypto.randomUUID(), uid, delta, String(kind || ""), Date.now()).run();
  } catch (e) {}
}
/* 포도톡 잔액에서만 깎기 (예전 cdTake 본체) */
async function ownTake(env, uid, cost, kind) {
  const r = await env.DB.prepare(
    `UPDATE pt_credits SET balance=balance-?, used=used+?, updated=?
      WHERE uid=? AND balance>=?`
  ).bind(cost, cost, Date.now(), uid, cost).run();
  const ok = !!(r.meta && r.meta.changes);
  if (ok) await cdLog(env, uid, -cost, kind);
  return ok;
}

/* 먼저 깎는다. 잔액이 모자라면 false 를 돌려주고 아무것도 하지 않는다.
   한 번의 UPDATE 안에서 잔액을 확인하고 깎으므로, 같은 사람이 동시에
   여러 번 눌러도 잔액보다 많이 나가지 않는다.
   coverfo 지갑에 연결한 사람: 포도톡 잔액 먼저 → 모자란 만큼 coverfo 에서. */
async function cdTake(env, uid, cost, kind) {
  if (!cost) return true;
  await cdRow(env, uid);
  /* 하루 상한 — 방 지갑에 넣고 빼는 것은 쓴 것이 아니라 옮긴 것이라 뺀다 */
  const moving = /^wallet/.test(String(kind || ""));
  if (!moving) {
    const spent = await cdDaySpent(env, uid);
    if (spent + cost > CD_DAY_CAP) return false;
  }
  let ok = await ownTake(env, uid, cost, kind);
  if (!ok) {
    const code = await cflCode(env, uid);
    if (code) {
      /* 포도톡에 남은 만큼 먼저 쓰고, 나머지를 coverfo 에서 */
      const own = Math.max(0, Math.min(cost - 1, await cdBalance(env, uid)));
      const part = own > 0 && (await ownTake(env, uid, own, kind)) ? own : 0;
      if (await cfSpend(env, code, cost - part, kind)) {
        await cdLog(env, uid, -(cost - part), "cf:" + String(kind || ""));
        ok = true;
      } else if (part) {
        await cdGive(env, uid, part, "cf-undo");      /* coverfo 도 모자라면 먼저 뺀 것을 되돌린다 */
      }
    }
  }
  if (ok && !moving) await cdDayAdd(env, uid, cost);
  return ok;
}

/* 돌려준다. 모델이 답을 못 줬을 때 쓴다. 돈만 나가고 아무것도 못 받으면 안 된다. */
async function cdGive(env, uid, amount, kind) {
  if (!amount) return;
  await env.DB.prepare(
    `INSERT INTO pt_credits(uid,balance,got,used,updated) VALUES(?,?,?,0,?)
     ON CONFLICT(uid) DO UPDATE SET balance=pt_credits.balance+excluded.balance,
       got=pt_credits.got+excluded.got, updated=excluded.updated`
  ).bind(uid, amount, amount, Date.now()).run();
  try {
    await env.DB.prepare(`INSERT INTO pt_credit_log(id,uid,delta,kind,ts) VALUES(?,?,?,?,?)`)
      .bind(crypto.randomUUID(), uid, amount, String(kind || ""), Date.now()).run();
  } catch (e) {}
}

/* ══ 한 달 상한 ═══════════════════════════════════════════
   사용량이 갑자기 튀면 청구서가 먼저 온다. 한 달에 몇 번까지만 우리 키로
   부르고, 넘으면 스스로 끈다. 크레딧이 있어도 넘으면 안 부른다.
   숫자를 세는 것뿐이라 값이 거의 들지 않는다. */
async function aiMeter(env) {
  const mon = new Date().toISOString().slice(0, 7);      /* 2026-08 */
  try {
    const r = await env.DB.prepare(`SELECT n FROM pt_ai_meter WHERE mon=?`).bind(mon).first();
    if ((r && r.n || 0) >= AI_MONTH_CAP) return false;
    await env.DB.prepare(
      `INSERT INTO pt_ai_meter(mon,n) VALUES(?,1)
       ON CONFLICT(mon) DO UPDATE SET n = pt_ai_meter.n + 1`
    ).bind(mon).run();
    return true;
  } catch (e) { return true; }        /* 표가 아직 없으면 막지 않는다 */
}

/* ══ 봇 하루 무료 한도 ═══════════════════════════════════
   키를 안 넣은 분에게도 맛은 보여드린다. 다만 사람이 늘면 이게 그대로
   비용이 되므로 하루 몇 번으로 끊는다. 넘으면 키를 넣으시라고 알린다.

   표를 먼저 만들어야 한다 (D1 콘솔) :
     CREATE TABLE IF NOT EXISTS pt_ai_usage (
       uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER DEFAULT 0,
       PRIMARY KEY(uid, day));                                   */
const BOT_FREE_PER_DAY = 5;

async function aiTake(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const r = await env.DB.prepare(`SELECT n FROM pt_ai_usage WHERE uid=? AND day=?`)
      .bind(uid, day).first();
    if ((r && r.n || 0) >= BOT_FREE_PER_DAY) return false;
    await env.DB.prepare(
      `INSERT INTO pt_ai_usage(uid,day,n) VALUES(?,?,1)
       ON CONFLICT(uid,day) DO UPDATE SET n = pt_ai_usage.n + 1`
    ).bind(uid, day).run();
    return true;
  } catch (e) { return true; }      /* 표가 아직 없으면 막지 않는다 */
}

/* 봇 대신 방에 안내를 남긴다. 모델은 부르지 않으므로 값이 들지 않는다. */
async function botSay(env, roomId, specs, icon, text) {
  const name = (specs && specs[0] && specs[0].name) || "bot";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO pt_messages(id,room_id,uid,nick,body,kind,meta,created) VALUES(?,?,?,?,?,'bot',?,?)`)
      .bind(crypto.randomUUID(), roomId, `bot:${name}`, name, text, JSON.stringify({ icon: icon || "🤖" }), now),
    env.DB.prepare(`UPDATE pt_rooms SET msg_count=msg_count+1,last_body=?,last_nick=?,last_ts=? WHERE id=?`)
      .bind(text.slice(0, 80), `@${name}`, now, roomId),
  ]);
}

/* 이용이 제한된 사람인가 */
async function modBanned(env, uid) {
  try {
    const b = await env.DB.prepare(`SELECT until,reason FROM pt_bans WHERE uid=?`).bind(uid).first();
    if (!b) return null;
    if (b.until && Date.now() > b.until) {
      await env.DB.prepare(`DELETE FROM pt_bans WHERE uid=?`).bind(uid).run();
      return null;
    }
    return b;
  } catch (e) { return null; }
}

/* 제한을 건다. 같은 사람을 여러 번 걸면 기간이 길어진다. */
async function modBan(env, uid, days, reason, reports) {
  const until = Date.now() + days * 86400e3;
  await env.DB.prepare(
    `INSERT INTO pt_bans(uid,until,reason,reports,ts) VALUES(?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET until=MAX(pt_bans.until,excluded.until),
       reason=excluded.reason, reports=excluded.reports, ts=excluded.ts`
  ).bind(uid, until, String(reason || "").slice(0, 120), reports || 0, Date.now()).run();
  return until;
}

/* ══ 라우터 ════════════════════════════════════════════════ */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    /* 어느 주소에서 왔는지 위의 cors() 가 알아야 한다. env 는 그대로 두고
       한 칸만 덧붙인다. */
    env = Object.assign({}, env, { __origin: req.headers.get("Origin") || "" });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    let body = {};
    if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }

    try {
      /* ── 상태 ── */
      if (p === "/" || p === "/health") {
        return json({ ok: true, name: "podotalk-api", ai: !!env.AI, push: !!env.VAPID_PUBLIC, ts: Date.now() }, env);
      }
      if (p === "/push/key") return json({ ok: true, key: env.VAPID_PUBLIC || "" }, env);

      /* ── 방 목록 ── */
      if (p === "/talk/rooms" && req.method === "GET") {
        const type = q.get("type");
        const uid = q.get("uid");
        if (type === "mine") {
          if (!uidOk(uid)) return json({ ok: true, rooms: [] }, env);
          const r = await env.DB.prepare(
            `SELECT r.* FROM pt_rooms r JOIN pt_members m ON m.room_id=r.id
             WHERE m.uid=? ORDER BY r.last_ts DESC LIMIT 100`
          ).bind(uid).all();
          return json({ ok: true, rooms: r.results || [] }, env);
        }
        const r = type
          ? await env.DB.prepare(`SELECT * FROM pt_rooms WHERE type=? AND is_private=0 ORDER BY last_ts DESC, created DESC LIMIT 100`).bind(type).all()
          : await env.DB.prepare(`SELECT * FROM pt_rooms WHERE is_private=0 ORDER BY last_ts DESC, created DESC LIMIT 100`).all();
        return json({ ok: true, rooms: r.results || [] }, env);
      }

      /* ── 방 하나 (id 또는 code) ── */
      if (p === "/talk/room" && req.method === "GET") {
        const id = q.get("id"), code = (q.get("code") || "").toUpperCase();
        const row = id
          ? await env.DB.prepare(`SELECT * FROM pt_rooms WHERE id=?`).bind(id).first()
          : await env.DB.prepare(`SELECT * FROM pt_rooms WHERE code=?`).bind(code).first();
        if (!row) return bad("방을 찾을 수 없습니다", env, 404);
        return json({ ok: true, room: row }, env);
      }

      /* ── 방 만들기 ── */
      if (p === "/talk/room/create" && req.method === "POST") {
        const name = clean(body.name, 40);
        const uid = clean(body.uid, 64);
        if (!name) return bad("방 이름을 입력해 주세요", env);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다. 앱을 새로고침해 주세요", env);
        const type = ["general", "study", "creator"].includes(body.type) ? body.type : "general";
        const id = crypto.randomUUID();
        const now = Date.now();
        const nick = clean(body.nick, 20) || "익명";
        const code = roomCode();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO pt_rooms(id,code,name,intro,type,emoji,owner_uid,owner_nick,is_private,is_paid,price,members,msg_count,last_ts,created)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`
          ).bind(id, code, name, clean(body.intro, 120), type, clean(body.emoji, 4) || "🍇",
                 uid, nick, body.is_private ? 1 : 0, body.is_paid ? 1 : 0,
                 Math.max(0, parseInt(body.price) || 0), now, now),
          env.DB.prepare(`INSERT INTO pt_members(room_id,uid,nick,joined,last_read) VALUES(?,?,?,?,?)`)
            .bind(id, uid, nick, now, now),
        ]);
        /* code 를 같이 돌려준다. 이게 없으면 앱이 초대 링크에 방 id 를 그대로
           박게 되어, 링크만 보고도 남의 방 주소를 짐작할 수 있게 된다. */
        return json({ ok: true, id, code, token: await issueToken(env, id, uid) }, env);
      }

      /* ── 방 입장 ── */
      if (p === "/talk/room/join" && req.method === "POST") {
        const { room_id } = body;
        const uid = clean(body.uid, 64);
        if (!room_id || !uidOk(uid)) return bad("입장 정보가 올바르지 않습니다", env);
        const exists = await env.DB.prepare(`SELECT id FROM pt_rooms WHERE id=?`).bind(room_id).first();
        if (!exists) return bad("방을 찾을 수 없습니다", env, 404);
        const already = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`).bind(room_id, uid).first();

        /* 인원 상한. 폴링이 사람 수만큼 늘어나므로 무한정 받을 수 없다. */
        if (!already) {
          const c = await env.DB.prepare(`SELECT COUNT(*) AS c FROM pt_members WHERE room_id=?`)
            .bind(room_id).first();
          if ((c && c.c || 0) >= ROOM_MAX) {
            return bad("이 방은 " + ROOM_MAX + "명까지예요. 방이 가득 찼습니다.", env, 409);
          }
        }

        const jlang = clean(body.lang, 8).toLowerCase();
        await env.DB.prepare(
          `INSERT INTO pt_members(room_id,uid,nick,joined,last_read,lang) VALUES(?,?,?,?,?,?)
           ON CONFLICT(room_id,uid) DO UPDATE SET nick=excluded.nick, last_read=excluded.last_read,
             lang=COALESCE(NULLIF(excluded.lang,''), pt_members.lang)`
        ).bind(room_id, uid, clean(body.nick, 20) || "익명", Date.now(), Date.now(), jlang).run();
        if (!already) await env.DB.prepare(`UPDATE pt_rooms SET members=members+1 WHERE id=?`).bind(room_id).run();
        return json({ ok: true, max: ROOM_MAX }, env);
      }

      /* ── 방 나가기 ── */
      if (p === "/talk/room/leave" && req.method === "POST") {
        const { room_id } = body;
        const uid = clean(body.uid, 64);
        const res = await env.DB.prepare(`DELETE FROM pt_members WHERE room_id=? AND uid=?`).bind(room_id, uid).run();
        if (res.meta?.changes) await env.DB.prepare(`UPDATE pt_rooms SET members=MAX(0,members-1) WHERE id=?`).bind(room_id).run();
        return json({ ok: true }, env);
      }

      /* ── 방 삭제 (방장) ── */
      if (p === "/talk/room/delete" && req.method === "POST") {
        const tok = await readToken(env, req);
        const room_id = body.room_id;
        if (!tok || tok.r !== room_id) return bad("방장만 삭제할 수 있습니다", env, 403);
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM pt_messages WHERE room_id=?`).bind(room_id),
          env.DB.prepare(`DELETE FROM pt_members WHERE room_id=?`).bind(room_id),
          env.DB.prepare(`DELETE FROM pt_tasks WHERE room_id=?`).bind(room_id),
          env.DB.prepare(`DELETE FROM pt_agents WHERE room_id=?`).bind(room_id),
          env.DB.prepare(`DELETE FROM pt_rooms WHERE id=?`).bind(room_id),
        ]);
        return json({ ok: true }, env);
      }

      /* ── 방 참여자 목록 ──
         지금까지 몇 명인지 숫자만 있고 누가 있는지 볼 길이 없었다. */
      if (p === "/talk/room/members" && req.method === "GET") {
        const room_id = url.searchParams.get("room_id") || "";
        if (!room_id) return bad("room_id 가 필요합니다", env);
        const room = await env.DB.prepare(`SELECT owner_uid FROM pt_rooms WHERE id=?`)
          .bind(room_id).first();
        if (!room) return bad("방을 찾을 수 없습니다", env, 404);
        const r = await env.DB.prepare(
          `SELECT uid,nick,joined FROM pt_members WHERE room_id=? ORDER BY joined ASC LIMIT 200`
        ).bind(room_id).all();
        const members = (r.results || []).map((m) => ({
          uid: m.uid, nick: m.nick || "익명", joined: m.joined,
          owner: m.uid === room.owner_uid ? 1 : 0,
        }));
        return json({ ok: true, members }, env);
      }

      /* ══ 프로필 사진 나눠 갖기 ═══════════════════════════════
         지금까지 프로필 사진은 각자 폰에만 있어서, 참여자 목록에 남의
         얼굴이 안 보였다. 사진을 여기에 맡겨두고 서로 받아가게 한다.

         R2 대신 D1 을 쓴다. 사진을 112px 로 줄여 한 장에 10~20KB 라
         따로 저장소를 붙이고 공개 주소를 관리할 만큼 크지 않다.

         표를 먼저 만들어야 한다 (D1 콘솔) :
           CREATE TABLE IF NOT EXISTS pt_avatars (
             uid TEXT PRIMARY KEY, data TEXT, ts INTEGER);
         ══════════════════════════════════════════════════════ */
      const AV_MAX = 90 * 1024;      /* 한 장 90KB 까지. 넘으면 받지 않는다 */

      /* 사진은 R2 에 둔다. D1 은 데이터베이스 하나가 10GB 까지라, 사진을
         base64 로 담으면 사람이 조금만 늘어도 벽에 부딪힌다. R2 는 용량
         제한이 없고 저장값도 훨씬 싸다.
         AVATARS 바인딩이 없으면 예전처럼 D1 에 담는다. 그래서 바인딩을
         붙이기 전에 올려도 아무것도 깨지지 않는다. */
      if (p === "/talk/avatar" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);

        const data = String(body.data || "");
        if (!data) {                                   /* 빈 값이면 지우기 */
          await env.DB.prepare(`DELETE FROM pt_avatars WHERE uid=?`).bind(uid).run();
          if (env.AVATARS) { try { await env.AVATARS.delete("av/" + uid); } catch (e) {} }
          return json({ ok: true, removed: 1 }, env);
        }
        /* 그림만 받는다. 다른 것을 담아 보내는 길로 쓰이지 않게 막는다. */
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
          return bad("사진 형식이 올바르지 않습니다", env);
        }
        if (data.length > AV_MAX) return bad("사진이 너무 큽니다", env);

        if (env.AVATARS) {
          await env.AVATARS.put("av/" + uid, data, {
            httpMetadata: { contentType: "text/plain", cacheControl: "public, max-age=86400" }
          });
          /* D1 에는 '어디에 있는지' 만 남긴다. 무게가 사라진다. */
          await env.DB.prepare(
            `INSERT INTO pt_avatars(uid,data,ts) VALUES(?,?,?)
             ON CONFLICT(uid) DO UPDATE SET data=excluded.data, ts=excluded.ts`
          ).bind(uid, "r2", Date.now()).run();
          return json({ ok: true, store: "r2" }, env);
        }

        await env.DB.prepare(
          `INSERT INTO pt_avatars(uid,data,ts) VALUES(?,?,?)
           ON CONFLICT(uid) DO UPDATE SET data=excluded.data, ts=excluded.ts`
        ).bind(uid, data, Date.now()).run();
        return json({ ok: true, store: "d1" }, env);
      }

      /* 여러 사람 사진을 한 번에 받아간다 */
      if (p === "/talk/avatars" && req.method === "GET") {
        const list = (q.get("uids") || "").split(",").map((x) => x.trim())
          .filter((x) => uidOk(x)).slice(0, 30);
        if (!list.length) return json({ ok: true, avatars: {} }, env);
        const r = await env.DB.prepare(
          `SELECT uid,data FROM pt_avatars WHERE uid IN (${list.map(() => "?").join(",")})`
        ).bind(...list).all();
        const avatars = {};
        const need = [];
        for (const row of (r.results || [])) {
          if (row.data === "r2") need.push(row.uid);      /* R2 에 있는 것 */
          else avatars[row.uid] = row.data;               /* 옛 방식 그대로 */
        }
        if (need.length && env.AVATARS) {
          await Promise.all(need.map(async (u) => {
            try {
              const o = await env.AVATARS.get("av/" + u);
              if (o) avatars[u] = await o.text();
            } catch (e) {}
          }));
        }
        return json({ ok: true, avatars }, env);
      }

      /* ══ 구글 로그인 ═════════════════════════════════════════
         포도톡은 폰 안의 무작위 uid 하나로 사람을 구분해 왔다. 그래서 폰을
         바꾸면 서버가 그 사람을 몰라 방 목록이 텅 비었다. 구글 계정을
         그 uid 에 묶어두면, 새 폰에서 로그인 한 번으로 되돌아온다.

         표를 먼저 만들어야 한다 (D1 콘솔) :
           CREATE TABLE IF NOT EXISTS pt_accounts (
             sub TEXT PRIMARY KEY, uid TEXT NOT NULL,
             email TEXT, name TEXT, ts INTEGER);

         GOOGLE_CLIENT_ID 를 워커 변수에 넣어야 한다. 비밀이 아니므로
         Plaintext 로 둬도 되지만, 재배포 때 지워지는 일을 겪으셨으니
         Encrypted Secret 으로 넣는 편이 안전하다.
         ══════════════════════════════════════════════════════ */
      if (p === "/talk/auth/google" && req.method === "POST") {
        const idToken = clean(body.id_token, 4096);
        const devUid = clean(body.uid, 64);
        if (!idToken) return bad("로그인 정보가 없습니다", env);
        if (!env.GOOGLE_CLIENT_ID) return bad("서버에 GOOGLE_CLIENT_ID 가 설정되지 않았습니다", env);

        /* 증명서 확인은 구글에 맡긴다. 서명·만료를 구글이 직접 검사해 준다. */
        let info = null;
        try {
          const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
          info = await r.json();
        } catch (e) { return bad("구글 확인에 실패했습니다", env); }

        if (!info || !info.sub) return bad("로그인 증명서를 읽지 못했습니다", env, 401);
        /* 남의 앱에서 받은 증명서를 들고 오는 것을 막는다 */
        if (info.aud !== env.GOOGLE_CLIENT_ID) return bad("이 앱의 로그인이 아닙니다", env, 401);
        if (info.exp && Number(info.exp) * 1000 < Date.now()) return bad("로그인이 만료됐습니다", env, 401);

        const sub = String(info.sub);
        const email = clean(info.email || "", 120);
        const name = clean(info.name || "", 40);

        const acct = await env.DB.prepare(`SELECT uid FROM pt_accounts WHERE sub=?`).bind(sub).first();
        let uid = acct && acct.uid;
        let moved = 0;

        if (!uid) {
          /* 처음 로그인 — 지금 이 폰의 uid 를 그대로 계정 uid 로 삼는다.
             그러면 이미 들어가 있던 방들이 그대로 따라온다. */
          uid = uidOk(devUid) ? devUid : ("u_" + crypto.randomUUID().slice(0, 8));
          await env.DB.prepare(
            `INSERT INTO pt_accounts(sub,uid,email,name,ts) VALUES(?,?,?,?,?)`
          ).bind(sub, uid, email, name, Date.now()).run();
        } else {
          await env.DB.prepare(`UPDATE pt_accounts SET email=?, name=?, ts=? WHERE sub=?`)
            .bind(email, name, Date.now(), sub).run();

          /* 다른 폰에서 쓰던 uid 로 들어가 있던 방들을 계정 uid 로 옮겨 붙인다.
             이미 계정 uid 로 들어가 있는 방은 건드리지 않는다(OR IGNORE). */
          if (uidOk(devUid) && devUid !== uid) {
            const rows = await env.DB.prepare(`SELECT room_id,nick,joined FROM pt_members WHERE uid=?`)
              .bind(devUid).all();
            for (const m of (rows.results || [])) {
              const r2 = await env.DB.prepare(
                `INSERT OR IGNORE INTO pt_members(room_id,uid,nick,joined,last_read) VALUES(?,?,?,?,?)`
              ).bind(m.room_id, uid, m.nick || name || "익명", m.joined || Date.now(), 0).run();
              if (r2.meta && r2.meta.changes) moved++;
            }
            await env.DB.prepare(`DELETE FROM pt_members WHERE uid=?`).bind(devUid).run();
            /* 번호 명부도 새 uid 로 옮긴다 */
            await env.DB.prepare(`UPDATE pt_phones SET uid=? WHERE uid=?`).bind(uid, devUid).run();
          }
        }
        /* 가입 선물 — 이 구글 계정에 한 번만. 한도(5만 명)에 닿으면 안 준다.
           로그인을 마친 뒤에 주므로, 앱을 지웠다 깔아도 다시 받을 수 없다. */
        const gift = await cdGift(env, sub, uid);
        const bal = await cdBalance(env, uid);

        return json({ ok: true, uid, email, name, moved,
                      gift: gift.given, balance: bal }, env);
      }

      /* 내 계정 확인 (로그인 상태 점검용) */
      if (p === "/talk/auth/me" && req.method === "GET") {
        const uid = q.get("uid") || "";
        if (!uidOk(uid)) return json({ ok: true, linked: false }, env);
        const a = await env.DB.prepare(`SELECT email,name FROM pt_accounts WHERE uid=?`).bind(uid).first();
        return json({ ok: true, linked: !!a, email: (a && a.email) || "", name: (a && a.name) || "" }, env);
      }

      /* ══ 한 번 누르면 등록까지 끝나는 초대 ═══════════════════════
         번호 등록을 사람 손으로 하게 두면 아무도 안 한다. 그래서 초대할 때
         그 번호 전용 열쇠를 만들어 문자 링크에 심는다. 상대가 링크를 누르면
         서버가 "이 열쇠는 그 번호에게 보낸 것" 을 알고 등록까지 대신 해준다.
         그래서 두 번째부터는 연락처에서 고르는 것만으로 바로 들어간다.

         표를 하나 더 만들어야 한다 (D1 콘솔) :
           CREATE TABLE IF NOT EXISTS pt_invites (
             token TEXT PRIMARY KEY, room_id TEXT NOT NULL, hash TEXT NOT NULL,
             by_uid TEXT, used INTEGER DEFAULT 0, ts INTEGER);
         ══════════════════════════════════════════════════════════ */

      /* 초대 열쇠 만들기 — 그 방에 들어와 있는 사람만 */
      if (p === "/talk/invite/create" && req.method === "POST") {
        const room_id = body.room_id;
        const me = clean(body.uid, 64);
        if (!room_id || !uidOk(me)) return bad("초대 정보가 올바르지 않습니다", env);
        const mem = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`)
          .bind(room_id, me).first();
        if (!mem) return bad("이 방에 들어와 있는 사람만 초대할 수 있습니다", env, 403);

        const hs = (Array.isArray(body.hashes) ? body.hashes : [])
          .filter((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)).slice(0, 20);
        const out = {};
        for (const h of hs) {
          const tk = roomCode() + roomCode();          /* 12자리 */
          await env.DB.prepare(
            `INSERT INTO pt_invites(token,room_id,hash,by_uid,used,ts) VALUES(?,?,?,?,0,?)`
          ).bind(tk, room_id, h, me, Date.now()).run();
          out[h] = tk;
        }
        return json({ ok: true, tokens: out }, env);
      }

      /* 초대 열쇠 쓰기 — 링크를 누른 사람을 방에 넣고 번호까지 등록한다 */
      if (p === "/talk/invite/claim" && req.method === "POST") {
        const tk = clean(body.token, 32).toUpperCase();
        const uid = clean(body.uid, 64);
        const nick = clean(body.nick, 20) || "익명";
        if (!tk || !uidOk(uid)) return bad("초대 정보가 올바르지 않습니다", env);

        const inv = await env.DB.prepare(`SELECT * FROM pt_invites WHERE token=?`).bind(tk).first();
        if (!inv) return bad("초대 링크가 만료됐거나 잘못됐습니다", env, 404);
        /* 30일이 지난 열쇠는 받지 않는다 */
        if (Date.now() - (inv.ts || 0) > 30 * 864e5) return bad("초대 링크가 만료됐습니다", env, 410);

        const room = await env.DB.prepare(`SELECT id,name,code FROM pt_rooms WHERE id=?`)
          .bind(inv.room_id).first();
        if (!room) return bad("방을 찾을 수 없습니다", env, 404);

        const already = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`)
          .bind(room.id, uid).first();
        if (!already) {
          await env.DB.prepare(`INSERT INTO pt_members(room_id,uid,nick,joined,last_read) VALUES(?,?,?,?,?)`)
            .bind(room.id, uid, nick, Date.now(), 0).run();
          await env.DB.prepare(`UPDATE pt_rooms SET members=members+1 WHERE id=?`).bind(room.id).run();
        }
        /* 여기가 핵심 — 손으로 하던 번호 등록을 대신 끝낸다 */
        await env.DB.prepare(
          `INSERT INTO pt_phones(hash,uid,nick,ts) VALUES(?,?,?,?)
           ON CONFLICT(hash) DO UPDATE SET uid=excluded.uid, nick=excluded.nick, ts=excluded.ts`
        ).bind(inv.hash, uid, nick, Date.now()).run();

        await env.DB.prepare(`UPDATE pt_invites SET used=used+1 WHERE token=?`).bind(tk).run();
        return json({ ok: true, room_id: room.id, name: room.name, code: room.code }, env);
      }

      /* ══ 연락처로 찾기 ═══════════════════════════════════════
         카톡은 주소록을 통째로 받아 가입자를 가려낸다. 여기서는 그렇게 하지
         않는다. 폰이 SHA-256 으로 바꾼 값만 오고, 서버는 해시끼리만 맞춘다.
         명부가 통째로 새더라도 전화번호는 복원되지 않는다.

         먼저 D1 콘솔에서 표를 한 번 만들어야 한다 :
           CREATE TABLE IF NOT EXISTS pt_phones (
             hash TEXT PRIMARY KEY, uid TEXT NOT NULL, nick TEXT, ts INTEGER);
           CREATE INDEX IF NOT EXISTS pt_phones_uid ON pt_phones(uid);
         ══════════════════════════════════════════════════════ */

      /* 내 번호 등록 · 해제 */
      if (p === "/talk/contacts/register" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        const hash = clean(body.hash, 64);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);
        if (!/^[0-9a-f]{64}$/.test(hash)) return bad("번호 형식이 올바르지 않습니다", env);

        if (body.remove) {
          await env.DB.prepare(`DELETE FROM pt_phones WHERE hash=? AND uid=?`).bind(hash, uid).run();
          return json({ ok: true }, env);
        }
        /* 같은 번호를 다른 사람이 다시 등록하면 최신 사람으로 덮는다.
           번호를 해지하고 남이 물려받는 경우가 실제로 있기 때문이다. */
        await env.DB.prepare(
          `INSERT INTO pt_phones(hash,uid,nick,ts) VALUES(?,?,?,?)
           ON CONFLICT(hash) DO UPDATE SET uid=excluded.uid, nick=excluded.nick, ts=excluded.ts`
        ).bind(hash, uid, clean(body.nick, 20) || "익명", Date.now()).run();
        return json({ ok: true }, env);
      }

      /* 고른 연락처 중 누가 가입자인지 */
      if (p === "/talk/contacts/match" && req.method === "POST") {
        /* 한 번에 많이 물어보면 명부를 훑는 통로가 된다. 50개로 끊는다. */
        const hs = (Array.isArray(body.hashes) ? body.hashes : [])
          .filter((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x))
          .slice(0, 50);
        if (!hs.length) return json({ ok: true, matches: {} }, env);

        const r = await env.DB.prepare(
          `SELECT hash,uid,nick FROM pt_phones WHERE hash IN (${hs.map(() => "?").join(",")})`
        ).bind(...hs).all();

        const matches = {};
        for (const row of (r.results || [])) matches[row.hash] = { uid: row.uid, nick: row.nick || "" };
        return json({ ok: true, matches }, env);
      }

      /* 고른 사람을 방에 바로 넣기 — 방장 토큰이 있어야 한다.
         이게 없으면 아무나 남을 아무 방에나 밀어넣을 수 있게 된다. */
      if (p === "/talk/room/invite" && req.method === "POST") {
        const room_id = body.room_id;
        const room = await env.DB.prepare(`SELECT id,name FROM pt_rooms WHERE id=?`).bind(room_id).first();
        if (!room) return bad("방을 찾을 수 없습니다", env, 404);

        /* 방장만 초대할 수 있게 해두면, 방장이 자리에 없을 때 아무도 사람을
           못 부른다. 그래서 '이미 그 방에 들어와 있는 사람' 이면 초대할 수
           있게 한다. 밖에 있는 사람은 여전히 못 넣는다. */
        const tok = await readToken(env, req);
        const me = clean(body.uid, 64);
        let allowed = !!(tok && tok.r === room_id);
        if (!allowed && uidOk(me)) {
          const mem = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`)
            .bind(room_id, me).first();
          allowed = !!mem;
        }
        if (!allowed) return bad("이 방에 들어와 있는 사람만 초대할 수 있습니다", env, 403);

        const uids = (Array.isArray(body.uids) ? body.uids : [])
          .filter((x) => uidOk(x)).slice(0, 30);
        const nowC = await env.DB.prepare(`SELECT COUNT(*) AS c FROM pt_members WHERE room_id=?`)
          .bind(room_id).first();
        let room$ = (nowC && nowC.c) || 0;
        let added = 0;
        for (const uid of uids) {
          if (room$ >= ROOM_MAX) break;                 /* 상한을 넘기지 않는다 */
          const already = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`)
            .bind(room_id, uid).first();
          if (already) continue;
          await env.DB.prepare(`INSERT INTO pt_members(room_id,uid,nick,joined,last_read) VALUES(?,?,?,?,?)`)
            .bind(room_id, uid, "익명", Date.now(), 0).run();
          added++; room$++;
        }
        if (added) {
          await env.DB.prepare(`UPDATE pt_rooms SET members=members+? WHERE id=?`).bind(added, room_id).run();
          /* 초대된 사람에게만 알린다. notifyRoom 은 보낸 사람을 빼는데,
             여기서는 초대한 나를 빼면 되므로 tok.u 를 넘긴다. */
          ctx.waitUntil(notifyRoom(env, room_id, (tok && tok.u) || me, {
            title: "포도톡",
            body: `『${room.name}』 방에 초대되었어요`,
            room_id,
          }));
        }
        return json({ ok: true, added }, env);
      }

      /* ── 메시지 읽기 (after 커서 = 폴링) ── */
      if (p === "/talk/messages" && req.method === "GET") {
        const room_id = q.get("room_id");
        if (!room_id) return bad("room_id가 필요합니다", env);
        const after = parseInt(q.get("after") || "0") || 0;
        const rows = after
          ? await env.DB.prepare(`SELECT * FROM pt_messages WHERE room_id=? AND created>? ORDER BY created ASC LIMIT 100`).bind(room_id, after).all()
          : await env.DB.prepare(`SELECT * FROM pt_messages WHERE room_id=? ORDER BY created DESC LIMIT 60`).bind(room_id).all();
        let list = after ? (rows.results || []) : (rows.results || []).reverse();

        /* 내가 차단한 사람과, 이용이 제한된 사람의 글은 빼고 보낸다.
           uid 를 안 보내면 예전처럼 그대로 돌려준다. */
        const me = q.get("uid") || "";
        if (uidOk(me) && list.length) {
          const hide = {};
          try {
            const bl = await env.DB.prepare(`SELECT blocked FROM pt_blocks WHERE uid=? LIMIT 500`).bind(me).all();
            for (const b of (bl.results || [])) hide[b.blocked] = 1;
            const bn = await env.DB.prepare(`SELECT uid FROM pt_bans WHERE until>? LIMIT 500`).bind(Date.now()).all();
            for (const b of (bn.results || [])) if (b.uid !== me) hide[b.uid] = 1;
          } catch (e) {}
          list = list.filter((m) => !hide[m.uid]);

          /* 내 언어로 미리 번역해 둔 것이 있으면 함께 보낸다.
             그러면 받는 폰이 따로 번역을 요청하지 않는다. */
          try {
            let ml = clean(q.get("lang") || "", 8).toLowerCase();
            if (!ml) {
              const mm = await env.DB.prepare(`SELECT lang FROM pt_members WHERE room_id=? AND uid=?`)
                .bind(room_id, me).first();
              ml = (mm && mm.lang) || "";
            }
            if (ml) list = await attachTr(env, list, ml);
          } catch (e) {}
        }
        return json({ ok: true, messages: list, now: Date.now() }, env);
      }

      /* ── 메시지 보내기 ── */
      if (p === "/talk/message" && req.method === "POST") {
        const room_id = clean(body.room_id, 64);
        const uid = clean(body.uid, 64);
        const nick = clean(body.nick, 20) || "익명";
        const text = clean(body.body, MSG_MAX);
        if (!room_id || !text) return bad("보낼 내용이 없습니다", env);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다. 앱을 새로고침해 주세요", env);

        const room = await env.DB.prepare(`SELECT id,name FROM pt_rooms WHERE id=?`).bind(room_id).first();
        if (!room) return bad("방을 찾을 수 없습니다", env, 404);

        /* 이용이 제한된 사람은 글을 쓸 수 없다 */
        const myBan = await modBanned(env, uid);
        if (myBan) {
          const d2 = new Date(myBan.until || Date.now());
          return bad("신고가 쌓여 글쓰기가 제한되었습니다. (" + (myBan.reason || "") + ") " +
            (d2.getMonth() + 1) + "월 " + d2.getDate() + "일까지입니다. 문의 hasin5jk@gmail.com", env, 403);
        }

        /* 글 걸러내기 — 거래·유인은 아예 보내지 않고, 욕설은 가려서 보낸다 */
        const mod = modCheck(text);
        if (mod.level === 2) {
          await env.DB.prepare(
            `INSERT INTO pt_reports(id,target_uid,by_uid,room_id,msg_id,body,reason,ts)
             VALUES(?,?,?,?,?,?,?,?)`
          ).bind(crypto.randomUUID(), uid, "__auto", room_id, "auto_" + Date.now(),
                 text.slice(0, 500), "자동감지:" + mod.hit, Date.now()).run();
          await modBan(env, uid, 30, "금지된 내용(" + mod.hit + ")", 0);
          return bad("보낼 수 없는 내용입니다. 마약·도박·총기·성매매 관련 거래 글은 금지됩니다. " +
            "잘못 걸렸다면 hasin5jk@gmail.com 으로 알려주세요.", env, 403);
        }
        const safeText = mod.level === 1 ? mod.text : text;

        const recent = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM pt_messages WHERE uid=? AND created>?`
        ).bind(uid, Date.now() - 60000).first();
        if ((recent?.c || 0) >= RATE_PER_MIN) return bad("잠시 후 다시 보내주세요", env, 429);

        const id = crypto.randomUUID();
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO pt_messages(id,room_id,uid,nick,body,kind,created) VALUES(?,?,?,?,?,'user',?)`)
            .bind(id, room_id, uid, nick, safeText, now),
          env.DB.prepare(`UPDATE pt_rooms SET msg_count=msg_count+1,last_body=?,last_nick=?,last_ts=? WHERE id=?`)
            .bind(safeText.slice(0, 80), nick, now, room_id),
          env.DB.prepare(
            `INSERT INTO pt_members(room_id,uid,nick,joined,last_read,lang) VALUES(?,?,?,?,?,?)
             ON CONFLICT(room_id,uid) DO UPDATE SET last_read=excluded.last_read,
               lang=COALESCE(NULLIF(excluded.lang,''), pt_members.lang)`
          ).bind(room_id, uid, nick, now, now, clean(body.lang, 8).toLowerCase()),
        ]);

        /* 방에 있는 언어들로 미리 번역해 둔다. 받는 사람은 요청하지 않아도 된다.
           답을 기다리지 않고 뒤에서 돌린다. 실패해도 대화는 그대로 간다. */
        ctx.waitUntil(preTranslate(env, room_id, id, safeText, clean(body.lang, 8), uid));

        /* 잔액이 바닥나면 앱이 알 수 있게 함께 알려준다. 말은 막지 않는다.
           번역만 안 될 뿐이고, 듣는 쪽은 원문을 그대로 본다. */
        let low = 0;
        try {
          const bb = await env.DB.prepare(`SELECT balance FROM pt_credits WHERE uid=?`).bind(uid).first();
          const ww = await env.DB.prepare(`SELECT balance FROM pt_wallets WHERE room_id=?`).bind(room_id).first();
          if ((bb && (bb.balance || 0) || 0) <= 0 && (ww && (ww.balance || 0) || 0) <= 0) low = 1;
          /* coverfo 지갑에 연결했으면 거기 잔액까지 보고 판단한다 (v76) */
          if (low) { const cc = await cflCode(env, uid); if (cc && (await cfPt(env, cc)) > 0) low = 0; }
        } catch (e) {}

        const names = [...new Set(
          [...text.matchAll(/(?:^|[\s(\[])@([a-z0-9_-]{2,24})/gi)].map((m) => m[1].toLowerCase())
        )].slice(0, BOT_MAX_PER_MSG);

        let bots = [];
        if (names.length) {
          const specs = await resolveMentions(env, room_id, names);
          bots = specs.map((s) => s.name);
          if (specs.length) {
            const ctxRows = await env.DB.prepare(
              `SELECT nick,body FROM pt_messages WHERE room_id=? ORDER BY created DESC LIMIT ?`
            ).bind(room_id, CTX_MSGS).all();
            const context = (ctxRows.results || []).reverse().map((r) => `${r.nick}: ${r.body}`).join("\n").slice(-2500);
            /* ── 봇을 부르기 전에 통과해야 하는 네 관문 ──
               ① 걸러내기 : AI 에게 넘길 글도 검사한다. 우리 키로 도는 이상
                  유해한 요청이 그대로 나가면 우리 계정이 정지될 수 있다.
                  한 사람 때문에 앱 전체의 AI 가 멈추는 일을 막는다.
               ② 자기 키   : 넣으신 분은 그 키로 돈다. 값이 안 드니 제한 없음.
               ③ 하루 무료 : 키가 없어도 하루 몇 번은 맛보게 한다 (Workers AI).
               ④ 크레딧    : 그 다음은 크레딧을 먼저 깎고 우리 키로 돈다.
                  반드시 먼저 깎는다. 부르고 나서 깎으면 실패한 요청으로
                  얼마든지 뽑아갈 수 있다. 답을 못 받으면 도로 넣어준다. */
            const ai = {};
            const uk = clean(body.ai_key, 200);
            const askMod = modCheck(text);

            if (askMod.level === 2) {
              ctx.waitUntil(botSay(env, room_id, specs, "🚫",
                "이 내용으로는 도와드릴 수 없어요."));
            } else if (uk) {
              ai.userKey = uk;
              ai.provider = clean(body.ai_provider, 20) || "claude";
              ctx.waitUntil(runBotsAndSave(env, room_id, specs, text, context, ai));
            } else if (await aiTake(env, uid)) {
              ctx.waitUntil(runBotsAndSave(env, room_id, specs, text, context, ai));
            } else if (!(await aiMeter(env))) {
              /* 이번 달 우리 키 사용량이 상한에 닿았다. 스스로 끈다. */
              ctx.waitUntil(botSay(env, room_id, specs, "🔒",
                "이번 달 AI 사용이 많아 잠시 쉬고 있어요.\n" +
                "설정 → AI 연결에서 내 키를 넣으면 바로 쓸 수 있어요."));
            } else if (await cdTake(env, uid, CD.ai, "ai")) {
              ai.managed = 1; ai.uid = uid; ai.cost = CD.ai;
              ctx.waitUntil(runBotsAndSave(env, room_id, specs, text, context, ai));
            } else {
              ctx.waitUntil(botSay(env, room_id, specs, "🍇",
                "크레딧이 부족해요. 설정 → 크레딧에서 채우거나,\n" +
                "설정 → AI 연결에서 내 키를 넣으면 제한 없이 쓸 수 있어요."));
            }
          }
        }
        ctx.waitUntil(notifyRoom(env, room_id, uid, {
          title: room.name, body: `${nick}: ${text.slice(0, 100)}`, room_id, tag: `room-${room_id}`,
        }));

        return json({ ok: true, id, created: now, bots, low }, env);
      }

      /* ── 봇 목록 ── */
      if (p === "/mcp/servers" && req.method === "GET") {
        const room_id = q.get("room_id");
        try { await syncBots(env); } catch (e) {}
        const mcp = await env.DB.prepare(`SELECT name,type,descr,icon FROM pt_mcp WHERE enabled=1 ORDER BY type,name`).all();
        let agents = [];
        if (room_id) {
          const a = await env.DB.prepare(`SELECT name,icon FROM pt_agents WHERE room_id=? LIMIT 20`).bind(room_id).all();
          agents = (a.results || []).map((x) => ({ name: x.name, type: "agent", descr: "이 방의 전용 봇", icon: x.icon || "✨" }));
        }
        return json({ ok: true, servers: [...(mcp.results || []), ...agents] }, env);
      }

      /* ── 봇 등록 (관리자) ── */
      if (p === "/mcp/register" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const name = clean(body.name, 24).toLowerCase();
        const mcpUrl = clean(body.url, 300);
        if (!/^[a-z0-9_-]{2,24}$/.test(name)) return bad("봇 이름은 영문 소문자·숫자·-·_ 2~24자입니다", env);
        if (!mcpUrl.startsWith("internal:") && !safeExternalUrl(mcpUrl)) return bad("https 주소만 등록할 수 있습니다", env);
        await env.DB.prepare(
          `INSERT INTO pt_mcp(id,name,url,type,descr,icon,enabled,created) VALUES(?,?,?,?,?,?,1,?)
           ON CONFLICT(name) DO UPDATE SET url=excluded.url,type=excluded.type,descr=excluded.descr,icon=excluded.icon`
        ).bind(crypto.randomUUID(), name, mcpUrl, clean(body.type, 20) || "general",
               clean(body.descr, 80), clean(body.icon, 4) || "🤖", Date.now()).run();
        return json({ ok: true }, env);
      }

      /* ── 방 전용 봇 만들기 (방장) ── */
      if (p === "/talk/agent/create" && req.method === "POST") {
        const tok = await readToken(env, req);
        const room_id = clean(body.room_id, 64);
        if (!tok || tok.r !== room_id) return bad("방장만 봇을 만들 수 있습니다", env, 403);
        const name = clean(body.name, 24).toLowerCase();
        if (!/^[a-z0-9_-]{2,24}$/.test(name)) return bad("봇 이름은 영문 소문자·숫자 2~24자입니다", env);
        const dup = await env.DB.prepare(`SELECT id FROM pt_mcp WHERE name=?`).bind(name).first();
        if (dup) return bad("기본 봇과 이름이 겹칩니다", env);
        await env.DB.prepare(`INSERT INTO pt_agents(id,room_id,name,prompt,icon,owner_uid,created) VALUES(?,?,?,?,?,?,?)`)
          .bind(crypto.randomUUID(), room_id, name, clean(body.prompt, 1000), clean(body.icon, 4) || "✨", tok.u, Date.now()).run();
        return json({ ok: true }, env);
      }

      /* ── 스터디 과제 ── */
      if (p === "/study/tasks" && req.method === "GET") {
        const rows = await env.DB.prepare(`SELECT * FROM pt_tasks WHERE room_id=? ORDER BY done ASC, due ASC LIMIT 100`)
          .bind(q.get("room_id")).all();
        return json({ ok: true, tasks: rows.results || [] }, env);
      }
      if (p === "/study/task/create" && req.method === "POST") {
        const title = clean(body.title, 100);
        if (!title || !body.room_id) return bad("과제 내용을 입력해 주세요", env);
        await env.DB.prepare(`INSERT INTO pt_tasks(id,room_id,title,due,created) VALUES(?,?,?,?,?)`)
          .bind(crypto.randomUUID(), body.room_id, title, parseInt(body.due) || Date.now() + 7 * 86400e3, Date.now()).run();
        return json({ ok: true }, env);
      }
      if (p === "/study/task/toggle" && req.method === "POST") {
        await env.DB.prepare(`UPDATE pt_tasks SET done=1-done, done_by=? WHERE id=?`)
          .bind(clean(body.nick, 20), body.id).run();
        return json({ ok: true }, env);
      }

      /* ── 푸시 구독 ── */
      if (p === "/push/subscribe" && req.method === "POST") {
        const s = body.sub || {};
        const keys = s.keys || {};
        if (!s.endpoint || !keys.p256dh || !keys.auth) return bad("구독 정보가 올바르지 않습니다", env);
        await env.DB.prepare(
          `INSERT INTO pt_subs(endpoint,uid,p256dh,auth,ts) VALUES(?,?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid,p256dh=excluded.p256dh,auth=excluded.auth,ts=excluded.ts`
        ).bind(s.endpoint, clean(body.uid, 64), keys.p256dh, keys.auth, Date.now()).run();
        return json({ ok: true }, env);
      }
      if (p === "/push/unsubscribe" && req.method === "POST") {
        await env.DB.prepare(`DELETE FROM pt_subs WHERE endpoint=?`).bind(body.endpoint || "").run();
        return json({ ok: true }, env);
      }
      if (p === "/push/test" && req.method === "POST") {
        const row = await env.DB.prepare(`SELECT endpoint,p256dh,auth FROM pt_subs WHERE uid=? LIMIT 3`)
          .bind(clean(body.uid, 64)).all();
        if (!(row.results || []).length) return bad("이 기기의 알림 구독을 찾을 수 없습니다", env, 404);
        for (const s of row.results) await pushTo(env, s, { title: "포도톡", body: "알림이 잘 도착합니다.", room_id: "" });
        return json({ ok: true }, env);
      }

      /* ── 포도다 가게 목록 (읽기 전용) ── */
      if (p === "/stores" && req.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT slug,name,emoji,cat,area,paused,menus,updated FROM store_meta WHERE paused=0 ORDER BY updated DESC LIMIT 100`
        ).all();
        return json({ ok: true, stores: rows.results || [] }, env);
      }

      /* ── 기본 봇 심기 (관리자, 최초 1회) ── */
      if (p === "/seed" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        /* 손으로도 돌릴 수 있게 남겨둔다. 실제 정리는 syncBots 가 한다. */
        await env.DB.prepare(`DELETE FROM pt_mcp WHERE url='internal:mark'`).run();
        await syncBots(env);
        return json({ ok: true, seeded: BOT_DEFS.length }, env);
      }

      /* ══ 계정 탈퇴 ═══════════════════════════════════════════
         쓰시는 분이 직접 지울 수 있어야 한다. 메일을 보내고 기다리게
         하지 않는다.

         남을 함부로 지우지 못하게 두 갈래로 나눈다.

         ① 구글 로그인을 해 둔 계정
            반드시 그 자리에서 받은 구글 증명서(id_token)를 함께 보내야 한다.
            증명서의 주인과 지우려는 uid 가 같을 때만 지운다.
            uid 는 참여자 목록에 드러나므로, uid 만으로 지우게 두면
            남의 계정을 지울 수 있게 된다.

         ② 로그인하지 않은 기기
            uid 말고는 주인을 확인할 방법이 없다. 그래서 이 경우에는
            방을 지우지 않는다. 앱이 자기가 가진 방장 열쇠로 직접 지운다.
            여기서는 명부·번호·알림·프로필 사진만 정리한다.
            (이것들은 지금도 앱이 하나씩 지울 수 있는 것들이라
             새로 열리는 권한이 없다.)
         ══════════════════════════════════════════════════════ */
      if (p === "/talk/account/delete" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);

        /* 이 uid 에 묶인 구글 계정이 있는지 먼저 본다 */
        const acct = await env.DB.prepare(`SELECT sub FROM pt_accounts WHERE uid=?`).bind(uid).first();

        let full = false;                 /* 방까지 지울 수 있는가 */

        if (acct) {
          /* ① 로그인 계정 — 구글 증명서로 본인 확인 */
          const idToken = clean(body.id_token, 4096);
          if (!idToken) return bad("구글 로그인 확인이 필요합니다", env, 401);
          if (!env.GOOGLE_CLIENT_ID) return bad("서버에 GOOGLE_CLIENT_ID 가 설정되지 않았습니다", env);

          let info = null;
          try {
            const r = await fetch(
              "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken)
            );
            info = await r.json();
          } catch (e) { return bad("구글 확인에 실패했습니다", env); }

          if (!info || !info.sub) return bad("로그인 증명서를 읽지 못했습니다", env, 401);
          if (info.aud !== env.GOOGLE_CLIENT_ID) return bad("이 앱의 로그인이 아닙니다", env, 401);
          if (info.exp && Number(info.exp) * 1000 < Date.now()) return bad("로그인이 만료됐습니다", env, 401);
          if (String(info.sub) !== String(acct.sub)) return bad("본인 계정이 아닙니다", env, 403);

          full = true;
        }

        let roomsDeleted = 0;

        if (full) {
          /* 내가 만든 방과 그 안의 대화를 통째로 지운다 */
          const owned = await env.DB.prepare(`SELECT id FROM pt_rooms WHERE owner_uid=? LIMIT 500`)
            .bind(uid).all();
          for (const r of (owned.results || [])) {
            await env.DB.batch([
              env.DB.prepare(`DELETE FROM pt_messages WHERE room_id=?`).bind(r.id),
              env.DB.prepare(`DELETE FROM pt_members  WHERE room_id=?`).bind(r.id),
              env.DB.prepare(`DELETE FROM pt_tasks    WHERE room_id=?`).bind(r.id),
              env.DB.prepare(`DELETE FROM pt_agents   WHERE room_id=?`).bind(r.id),
              env.DB.prepare(`DELETE FROM pt_invites  WHERE room_id=?`).bind(r.id),
              env.DB.prepare(`DELETE FROM pt_rooms    WHERE id=?`).bind(r.id),
            ]);
            roomsDeleted++;
          }
        }

        /* 남의 방에 들어가 있던 자리에서 빠져나온다.
           사람 수를 하나씩 줄여줘야 목록의 숫자가 어긋나지 않는다. */
        const mem = await env.DB.prepare(`SELECT room_id FROM pt_members WHERE uid=? LIMIT 500`)
          .bind(uid).all();
        let left = 0;
        for (const m of (mem.results || [])) {
          await env.DB.prepare(`UPDATE pt_rooms SET members=MAX(0,members-1) WHERE id=?`)
            .bind(m.room_id).run();
          left++;
        }
        await env.DB.prepare(`DELETE FROM pt_members WHERE uid=?`).bind(uid).run();

        /* 번호 명부 · 알림 주소 · 프로필 사진 · 내가 만든 초대 열쇠 */
        await env.DB.prepare(`DELETE FROM pt_phones  WHERE uid=?`).bind(uid).run();
        await env.DB.prepare(`DELETE FROM pt_subs    WHERE uid=?`).bind(uid).run();
        try { await env.DB.prepare(`DELETE FROM pt_avatars WHERE uid=?`).bind(uid).run(); } catch (e) {}
        try { await env.DB.prepare(`DELETE FROM pt_invites WHERE by_uid=?`).bind(uid).run(); } catch (e) {}
        /* 계정 열쇠도 함께 지운다. 남아 있으면 지운 계정의 지갑에 다시
           붙을 수 있는 열쇠가 떠돌게 된다. */
        try { await env.DB.prepare(`DELETE FROM pt_keys WHERE uid=?`).bind(uid).run(); } catch (e) {}

        /* 계정 자체 — 구글 식별번호 · 이메일 · 이름 */
        if (full) await env.DB.prepare(`DELETE FROM pt_accounts WHERE uid=?`).bind(uid).run();

        return json({ ok: true, full, rooms: roomsDeleted, left, account: full ? 1 : 0 }, env);
      }

      /* ══ 크레딧 ═══════════════════════════════════════════════
         잔액 보기 · 코드로 채우기 · 관리자가 코드 만들기.
         표는 d1-크레딧.sql 로 미리 만들어 두어야 한다.          */

      if (p === "/talk/credits" && req.method === "GET") {
        const uid = q.get("uid") || "";
        if (!uidOk(uid)) return json({ ok: true, balance: 0, cost: CD }, env);
        const r = await cdRow(env, uid);
        const spent = await cdDaySpent(env, uid);
        return json({ ok: true, balance: (r && r.balance) || 0, cost: CD,
                      cf: (await cflCode(env, uid)) ? 1 : 0,
                      dayLeft: Math.max(0, CD_DAY_CAP - spent), dayCap: CD_DAY_CAP }, env);
      }

      /* 가입 선물을 몇 명에게 줬는지 (관리자) — 한도가 얼마나 남았는지 본다 */
      if (p === "/talk/signups" && req.method === "GET") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const m = await env.DB.prepare(`SELECT v FROM pt_meta WHERE k='signup_n'`).first();
        const n = (m && m.v) || 0;
        return json({ ok: true, given: n, cap: SIGNUP_CAP, left: Math.max(0, SIGNUP_CAP - n),
                      each: CD_SIGNUP }, env);
      }

      /* ══ 계정 열쇠 ═══════════════════════════════════════════
         포도야는 다른 도메인이다. 크롬은 포도톡 안에 뜬 포도야의 저장소를
         아예 다른 칸으로 관리하기 때문에, 포도야는 열쇠를 받기 전에는
         자기가 누구인지 알 방법이 없다. 이 열쇠가 그 다리다.

         uid 만으로는 내주지 않는다. 구글 로그인을 한 번 거친 사람에게만
         내준다. 그러지 않으면 참여자 목록에서 uid 를 본 사람이 남의
         지갑을 가져갈 수 있다.

         표를 먼저 만들어야 한다 (D1 콘솔) :
           CREATE TABLE IF NOT EXISTS pt_keys (
             key TEXT PRIMARY KEY, uid TEXT NOT NULL, ts INTEGER);
           CREATE INDEX IF NOT EXISTS pt_keys_uid ON pt_keys(uid);      */
      if (p === "/talk/account/key" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        const idToken = clean(body.id_token, 4096);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);
        if (!idToken) return bad("구글 로그인을 먼저 해주세요", env, 401);
        if (!env.GOOGLE_CLIENT_ID) return bad("서버에 GOOGLE_CLIENT_ID 가 없습니다", env);

        let info = null;
        try {
          const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" +
                                encodeURIComponent(idToken));
          info = await r.json();
        } catch (e) { return bad("구글 확인에 실패했습니다", env); }
        if (!info || !info.sub) return bad("로그인 증명서를 읽지 못했습니다", env, 401);
        if (info.aud !== env.GOOGLE_CLIENT_ID) return bad("이 앱의 로그인이 아닙니다", env, 401);
        if (info.exp && Number(info.exp) * 1000 < Date.now()) return bad("로그인이 만료됐습니다", env, 401);

        /* 그 구글 계정에 묶인 uid 가 진짜 주인이다. 보내온 uid 는 믿지 않는다. */
        const acct = await env.DB.prepare(`SELECT uid FROM pt_accounts WHERE sub=?`)
          .bind(String(info.sub)).first();
        const owner = (acct && acct.uid) || uid;
        if (!acct) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO pt_accounts(sub,uid,email,name,ts) VALUES(?,?,?,?,?)`
          ).bind(String(info.sub), owner, clean(info.email || "", 120),
                 clean(info.name || "", 40), Date.now()).run();
        }

        let row = await env.DB.prepare(`SELECT key FROM pt_keys WHERE uid=?`).bind(owner).first();
        /* 열쇠가 샜을 때 새로 만든다. 옛 열쇠는 그 순간 못 쓰게 된다. */
        if (body.renew && row) {
          await env.DB.prepare(`DELETE FROM pt_keys WHERE uid=?`).bind(owner).run();
          row = null;
        }
        if (!row) {
          const k = accountKey();
          await env.DB.prepare(`INSERT INTO pt_keys(key,uid,ts) VALUES(?,?,?)`)
            .bind(k, owner, Date.now()).run();
          row = { key: k };
        }
        await cdRow(env, owner);            /* 지갑이 없으면 여기서 만들어 둔다 */
        return json({ ok: true, key: row.key, uid: owner,
                      token: await issueUserToken(env, owner) }, env);
      }

      /* ══ 포도야에서 들어온 구글 로그인 ══
         포도야는 주소가 달라서 /talk/auth/google 을 직접 못 부른다(CORS).
         그래서 포도야 워커가 대신 물어본다. 확인·계정 만들기·선물은
         전부 여기 한 곳에서 한다 — 로그인 규칙이 두 벌이 되면 언젠가
         서로 어긋난다. */
      if (p === "/link/google" && req.method === "POST") {
        const lk0 = req.headers.get("X-Link-Key") || "";
        if (!env.LINK_KEY || !timingSafeEq(lk0, env.LINK_KEY)) {
          return bad("권한이 없습니다", env, 403);
        }
        const idToken = clean(body.id_token, 4096);
        if (!idToken) return bad("로그인 정보가 없습니다", env);
        if (!env.GOOGLE_CLIENT_ID) return bad("서버에 GOOGLE_CLIENT_ID 가 없습니다", env);

        let gi = null;
        try {
          const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" +
                                encodeURIComponent(idToken));
          gi = await r.json();
        } catch (e) { return bad("구글 확인에 실패했습니다", env); }
        if (!gi || !gi.sub) return bad("로그인 증명서를 읽지 못했습니다", env, 401);
        if (gi.aud !== env.GOOGLE_CLIENT_ID) return bad("이 앱의 로그인이 아닙니다", env, 401);
        if (gi.exp && Number(gi.exp) * 1000 < Date.now()) return bad("로그인이 만료됐습니다", env, 401);

        const gsub = String(gi.sub);
        let acc = await env.DB.prepare(`SELECT uid FROM pt_accounts WHERE sub=?`).bind(gsub).first();
        let guid = acc && acc.uid;
        if (!guid) {
          guid = "u_" + crypto.randomUUID().slice(0, 8);
          await env.DB.prepare(
            `INSERT INTO pt_accounts(sub,uid,email,name,ts) VALUES(?,?,?,?,?)`
          ).bind(gsub, guid, clean(gi.email || "", 120), clean(gi.name || "", 40), Date.now()).run();
        }
        await cdRow(env, guid);
        const g2 = await cdGift(env, gsub, guid);
        return json({ ok: true, uid: guid, email: clean(gi.email || "", 120),
                      name: clean(gi.name || "", 40), gift: g2.given,
                      balance: await cdBalance(env, guid),
                      token: await issueUserToken(env, guid) }, env);
      }

      /* 이번 달 우리 키 사용량을 세어 준다 — 포도야 워커가 부른다.
         계량기를 한 곳에 두면 포도톡·포도야를 합쳐서 볼 수 있다.
         따로 두면 각각 상한을 넘지 않았는데 합쳐서 넘는 일이 생긴다. */
      if (p === "/link/meter" && req.method === "POST") {
        const lk1 = req.headers.get("X-Link-Key") || "";
        if (!env.LINK_KEY || !timingSafeEq(lk1, env.LINK_KEY)) {
          return bad("권한이 없습니다", env, 403);
        }
        const cap = Math.max(1, parseInt(body.cap) || AI_MONTH_CAP);
        const mon = new Date().toISOString().slice(0, 7);
        try {
          const r = await env.DB.prepare(`SELECT n FROM pt_ai_meter WHERE mon=?`).bind(mon).first();
          const n = (r && r.n) || 0;
          if (n >= cap) return json({ ok: false, over: 1, n, cap }, env);
          await env.DB.prepare(
            `INSERT INTO pt_ai_meter(mon,n) VALUES(?,1)
             ON CONFLICT(mon) DO UPDATE SET n = pt_ai_meter.n + 1`
          ).bind(mon).run();
          return json({ ok: true, n: n + 1, cap }, env);
        } catch (e) { return json({ ok: true, n: 0, cap }, env); }
      }

      /* 열쇠를 토큰으로 바꿔준다 — 포도야 워커만 부른다.
         사람이 부르는 곳이 아니므로 LINK_KEY 로 잠근다. */
      if (p === "/link/account" && req.method === "POST") {
        const lk = req.headers.get("X-Link-Key") || "";
        if (!env.LINK_KEY || !timingSafeEq(lk, env.LINK_KEY)) {
          return bad("권한이 없습니다", env, 403);
        }
        if (body.token) {
          const t = await readUserToken(env, String(body.token));
          if (!t) return bad("토큰이 올바르지 않습니다", env, 401);
          return json({ ok: true, uid: t.u }, env);
        }
        const key = clean(body.key, 20).toUpperCase();
        if (!/^PODO-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) {
          return bad("열쇠 형식이 달라요 (PODO-XXXX-XXXX)", env);
        }
        const row = await env.DB.prepare(`SELECT uid FROM pt_keys WHERE key=?`).bind(key).first();
        if (!row) return bad("없는 열쇠입니다", env, 404);
        return json({ ok: true, uid: row.uid,
                      token: await issueUserToken(env, row.uid) }, env);
      }

      /* ══ 다른 서버가 쓰는 통로 ═══════════════════════════════
         포도랑(전화통역·마주보고 통역·사진 번역)과 포도야(AI 대화·웹검색·
         받아쓰기)가 여기에 물어보고 깎는다. 이용권을 따로 두지 않고
         크레딧 하나로 모으기 위한 길이다.

         사람이 부르는 곳이 아니다. 서버끼리만 쓴다. 그래서 공유 열쇠로
         잠근다. 열쇠가 없으면 아무것도 안 알려주고 깎지도 않는다.
           Workers & Pages → podotalk-api → Settings
             → Variables and Secrets → Add
               Type : Secret    이름 : LINK_KEY    값 : (아무 긴 글자)
           같은 값을 podolang-realtime · podolang · podoya-api 에도 넣는다. */
      if (p === "/link/credits" && (req.method === "POST" || req.method === "GET")) {
        const key = req.headers.get("X-Link-Key") || "";
        if (!env.LINK_KEY || !timingSafeEq(key, env.LINK_KEY)) {
          return bad("권한이 없습니다", env, 403);
        }
        /* 포도랑은 예전처럼 uid 를 그대로 보낸다. 포도야는 기기 토큰을 보낸다.
           토큰이 오면 서명을 확인해서 uid 를 꺼낸다 — 앱이 남의 uid 를
           적어 보내는 길을 막는다. */
        const rawTok = req.method === "GET" ? (q.get("token") || "") : (body.token || "");
        let uid = "";
        if (rawTok) {
          const tk = await readUserToken(env, String(rawTok));
          if (!tk) return bad("토큰이 올바르지 않습니다", env, 401);
          uid = tk.u;
        } else {
          uid = clean(req.method === "GET" ? (q.get("uid") || "") : body.uid, 64);
        }
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);

        /* 얼마나 남았는지 (통화 시작 전에 물어본다) */
        if (req.method === "GET") {
          const bal = await payBalance(env, uid);
          return json({ ok: true, balance: bal, cost: CD,
                        minutes: Math.floor(bal / CD.phone) }, env);
        }

        /* 돌려주기 — 모델이 답을 못 줬을 때 포도야가 부른다.
           돈만 나가고 아무것도 못 받는 일이 있으면 안 된다. */
        if (body.give) {
          const back = Math.max(0, Math.min(100000, Math.round((parseFloat(body.give) || 0) * 10) / 10));
          if (back) await cdGive(env, uid, back, clean(body.kind, 20) || "podoya-refund");
          return json({ ok: true, gave: back, balance: await payBalance(env, uid) }, env);
        }

        /* 실제로 깎기. 모자라면 남은 만큼만 깎고 얼마를 깎았는지 알려준다. */
        const want = Math.max(0, Math.min(100000, Math.round((parseFloat(body.amount) || 0) * 10) / 10));
        if (!want) return bad("얼마를 깎을지 정해 주세요", env);
        const kind = clean(body.kind, 20) || "podolang";

        const bal = await payBalance(env, uid);
        const dayLeft = Math.max(0, CD_DAY_CAP - (await cdDaySpent(env, uid)));
        const take = Math.min(want, bal, dayLeft);
        if (take <= 0) {
          return json({ ok: false, took: 0, balance: bal, short: 1,
                        day: dayLeft <= 0 ? 1 : 0 }, env);   /* day=1 이면 하루 상한 */
        }
        if (!(await cdTake(env, uid, take, kind))) {
          return json({ ok: false, took: 0, balance: await payBalance(env, uid), short: 1, day: 0 }, env);
        }
        return json({ ok: true, took: take, balance: bal - take,
                      short: take < want ? 1 : 0 }, env);
      }

      /* ══ 주문 ═══════════════════════════════════════════════
         카드 결제가 붙기 전까지 쓰는 임시 통로다. 손님이 앱에서 누르면
         주문이 여기 쌓인다. 사장님은 입금을 확인하고 승인만 누르면
         크레딧이 그 사람에게 바로 들어간다. 코드를 만들어 메일로
         보내고, 손님이 옮겨 적는 과정이 전부 사라진다.

         나중에 결제가 붙으면 '승인' 을 결제사가 대신 부르면 된다.
         표는 d1-주문.sql 참고 */

      /* 손님이 신청 */
      if (p === "/talk/order" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        const pid = clean(body.pack, 20);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);
        const pack = CD_PACKS.filter((x) => x.id === pid)[0];
        if (!pack) return bad("없는 상품입니다", env);

        /* 입금자명으로 쓸 짧은 번호. 이것만 보고 누가 넣었는지 찾는다. */
        const no = roomCode();
        await env.DB.prepare(
          `INSERT INTO pt_orders(no,uid,pack,credits,krw,nick,state,ts)
           VALUES(?,?,?,?,?,?, 'wait', ?)`
        ).bind(no, uid, pack.id, pack.credits, pack.krw, clean(body.nick, 20), Date.now()).run();

        return json({ ok: true, no, credits: pack.credits, krw: pack.krw,
                      bank: env.BANK_INFO || "" }, env);
      }

      /* 내 주문 확인 — 승인됐는지 앱이 물어본다 */
      if (p === "/talk/order" && req.method === "GET") {
        const no = clean(q.get("no") || "", 16).toUpperCase();
        if (!no) return json({ ok: true, state: "" }, env);
        const r = await env.DB.prepare(`SELECT no,credits,krw,state FROM pt_orders WHERE no=?`)
          .bind(no).first();
        return json({ ok: true, order: r || null }, env);
      }

      /* 기다리는 주문 보기 (관리자) */
      if (p === "/talk/orders" && req.method === "GET") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const r = await env.DB.prepare(
          `SELECT * FROM pt_orders WHERE state='wait' ORDER BY ts DESC LIMIT 100`
        ).all();
        return json({ ok: true, orders: r.results || [] }, env);
      }

      /* 승인 — 이 한 번으로 크레딧이 바로 들어간다 (관리자) */
      if (p === "/talk/order/ok" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const no = clean(body.no, 16).toUpperCase();
        if (!no) return bad("주문번호가 필요합니다", env);

        /* 먼저 잠근다. 두 번 눌러도 한 번만 들어간다. */
        const lock = await env.DB.prepare(
          `UPDATE pt_orders SET state='done', done_at=? WHERE no=? AND state='wait'`
        ).bind(Date.now(), no).run();
        if (!(lock.meta && lock.meta.changes)) return bad("이미 처리했거나 없는 주문입니다", env, 409);

        const o = await env.DB.prepare(`SELECT uid,credits FROM pt_orders WHERE no=?`).bind(no).first();
        if (!o) return bad("주문을 찾을 수 없습니다", env, 404);
        await cdGive(env, o.uid, o.credits, "order:" + no);
        return json({ ok: true, uid: o.uid, credits: o.credits }, env);
      }

      /* 파는 묶음 목록. 값을 한 곳에서만 고치면 앱에도 바로 반영된다. */
      if (p === "/talk/credits/packs" && req.method === "GET") {
        return json({ ok: true, packs: CD_PACKS, cost: CD }, env);
      }

      /* coverfo 지갑 연결/끊기 (v76) — 앱이 연결 코드 CF-XXXX-XXXX 를 알려준다.
         빈 코드면 끊는다. 코드는 coverfo 에 물어봐서 살아 있을 때만 저장한다. */
      if (p === "/talk/credits/link" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);
        await cflReady(env);
        const code = clean(body.cf_code, 20).toUpperCase();
        if (!code) {
          await env.DB.prepare(`DELETE FROM pt_cflink WHERE uid=?`).bind(uid).run();
          return json({ ok: true, linked: false }, env);
        }
        if (!/^CF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return bad("코드 모양이 달라요 (CF-XXXX-XXXX)", env);
        const chk = await cfCall(env, { op: "balance", code });
        if (chk.status !== 200 || !chk.j.ok) return bad("coverfo 에서 확인되지 않는 코드예요", env, 400);
        await env.DB.prepare(
          `INSERT INTO pt_cflink(uid,code,ts) VALUES(?,?,?)
           ON CONFLICT(uid) DO UPDATE SET code=excluded.code, ts=excluded.ts`
        ).bind(uid, code, Date.now()).run();
        return json({ ok: true, linked: true, paid: Number(chk.j.paid || 0) }, env);
      }

      /* 코드를 넣어 채운다. 코드는 한 번만 쓸 수 있다. */
      if (p === "/talk/credits/redeem" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        const code = clean(body.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!uidOk(uid)) return bad("사용자 정보가 없습니다", env);
        if (!code) return bad("코드를 입력해 주세요", env);

        const row = await env.DB.prepare(`SELECT * FROM pt_codes WHERE code=?`).bind(code).first();
        if (!row) return bad("없는 코드입니다. 다시 확인해 주세요", env, 404);
        if (row.used_by) return bad("이미 사용된 코드입니다", env, 409);
        if (row.expires && Date.now() > row.expires) return bad("기한이 지난 코드입니다", env, 410);

        /* 먼저 코드를 잠근다. 두 사람이 동시에 넣어도 한 번만 들어간다. */
        const lock = await env.DB.prepare(
          `UPDATE pt_codes SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL`
        ).bind(uid, Date.now(), code).run();
        if (!(lock.meta && lock.meta.changes)) return bad("이미 사용된 코드입니다", env, 409);

        await cdGive(env, uid, row.amount || 0, "redeem:" + code);
        const r = await cdRow(env, uid);
        return json({ ok: true, added: row.amount || 0, balance: (r && r.balance) || 0 }, env);
      }

      /* ══ 방 지갑 ═══════════════════════════════════════════
         사장이 사람마다 나눠주는 건 번거롭다. 방에 한 번 넣어두면
         그 방에서 말하는 사람들이 거기서 꺼내 쓴다.

         쓰는 차례 : ① 방 지갑 → ② 없으면 내 크레딧
         안 쓴 몫은 방에 그대로 남아 있고, 넣은 사람이 언제든 되돌려받는다.

         ★ 남의 잔액은 어디서도 알려주지 않는다. 방 지갑의 남은 양만 보인다.
           누가 얼마나 썼는지도 방 사람들에게 보이지 않는다.          */

      /* 방 지갑에 넣기 · 되돌려받기 (방장만) */
      if (p === "/talk/room/wallet" && req.method === "POST") {
        const tok = await readToken(env, req);
        const room_id = clean(body.room_id, 64);
        const me = clean(body.uid, 64);
        if (!uidOk(me)) return bad("사용자 정보가 없습니다", env);
        if (!tok || tok.r !== room_id) return bad("방을 만든 분만 넣고 뺄 수 있습니다", env, 403);

        /* 지갑은 다중 동시통역방에만 둔다. 방을 만들 때 붙인 이모지(👪)로
           가려낸다. 1:1 통역·마주보기·전화통역은 개인이 쓰는 것이라
           방장이 대신 내주면 아무도 방을 안 만든다. */
        const rm = await env.DB.prepare(`SELECT emoji FROM pt_rooms WHERE id=?`).bind(room_id).first();
        if (!rm || rm.emoji !== "👪") {
          return bad("지갑은 다중 동시통역방에만 둘 수 있어요", env, 400);
        }

        const amount = Math.max(0, Math.min(1000000, parseInt(body.amount) || 0));

        if (body.take) {
          /* 되돌려받기 — 남은 만큼만 */
          const w = await env.DB.prepare(`SELECT balance FROM pt_wallets WHERE room_id=?`)
            .bind(room_id).first();
          const have = (w && w.balance) || 0;
          const back = amount ? Math.min(amount, have) : have;
          if (back <= 0) return bad("되돌려받을 크레딧이 없습니다", env);
          const r = await env.DB.prepare(
            `UPDATE pt_wallets SET balance=balance-?, updated=? WHERE room_id=? AND balance>=?`
          ).bind(back, Date.now(), room_id, back).run();
          if (!(r.meta && r.meta.changes)) return bad("되돌려받지 못했습니다", env);
          await cdGive(env, me, back, "wallet-back:" + room_id);
          return json({ ok: true, back, left: have - back }, env);
        }

        /* 내는 방식만 바꾸기 (넣는 것과 따로) */
        if (body.pay) {
          const pay = body.pay === "each" ? "each" : "wallet";
          await env.DB.prepare(
            `INSERT INTO pt_wallets(room_id,balance,by_uid,updated,pay) VALUES(?,0,?,?,?)
             ON CONFLICT(room_id) DO UPDATE SET pay=excluded.pay, updated=excluded.updated`
          ).bind(room_id, me, Date.now(), pay).run();
          return json({ ok: true, pay }, env);
        }

        if (!amount) return bad("얼마를 넣을지 정해 주세요", env);
        if (!(await cdTake(env, me, amount, "wallet-in:" + room_id))) {
          return bad("내 크레딧이 " + amount.toLocaleString() + "개 필요해요", env, 402);
        }
        await env.DB.prepare(
          `INSERT INTO pt_wallets(room_id,balance,by_uid,updated) VALUES(?,?,?,?)
           ON CONFLICT(room_id) DO UPDATE SET balance=pt_wallets.balance+excluded.balance,
             updated=excluded.updated`
        ).bind(room_id, amount, me, Date.now()).run();
        const w2 = await env.DB.prepare(`SELECT balance FROM pt_wallets WHERE room_id=?`)
          .bind(room_id).first();
        return json({ ok: true, added: amount, wallet: (w2 && w2.balance) || 0 }, env);
      }

      /* 방 지갑 남은 양 보기 — 방에 있는 사람이면 누구나 */
      if (p === "/talk/room/wallet" && req.method === "GET") {
        const room_id = q.get("room_id") || "";
        const uid = q.get("uid") || "";
        if (!room_id || !uidOk(uid)) return json({ ok: true, wallet: 0 }, env);
        const mem = await env.DB.prepare(`SELECT uid FROM pt_members WHERE room_id=? AND uid=?`)
          .bind(room_id, uid).first();
        if (!mem) return json({ ok: true, wallet: 0 }, env);
        const w = await env.DB.prepare(`SELECT balance,pay FROM pt_wallets WHERE room_id=?`)
          .bind(room_id).first();
        return json({ ok: true, wallet: (w && w.balance) || 0,
                      pay: (w && w.pay) || "wallet" }, env);
      }

      /* 코드 만들기 (관리자). 판매하거나 나눠줄 때 쓴다. */
      if (p === "/talk/credits/make" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const amount = Math.max(1, parseInt(body.amount) || 1000);
        const count = Math.min(200, Math.max(1, parseInt(body.count) || 1));
        const days = Math.max(0, parseInt(body.days) || 0);
        const expires = days ? Date.now() + days * 86400e3 : 0;
        const out = [];
        for (let i = 0; i < count; i++) {
          const code = "PODO" + roomCode() + roomCode();
          await env.DB.prepare(
            `INSERT INTO pt_codes(code,amount,expires,used_by,used_at,ts) VALUES(?,?,?,NULL,NULL,?)`
          ).bind(code, amount, expires, Date.now()).run();
          out.push(code);
        }
        return json({ ok: true, amount, codes: out }, env);
      }

      /* 이번 달 우리 키 사용량 (관리자) — 청구서가 오기 전에 미리 본다 */
      if (p === "/talk/aimeter" && req.method === "GET") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const r = await env.DB.prepare(`SELECT mon,n FROM pt_ai_meter ORDER BY mon DESC LIMIT 12`).all();
        return json({ ok: true, cap: AI_MONTH_CAP, months: r.results || [] }, env);
      }

      /* ══ 오래된 메시지 내리기 ═════════════════════════════════
         D1 은 데이터베이스 하나가 10GB 까지다. 메시지가 쌓이면 언젠가
         반드시 막힌다. 90일이 지난 글은 R2 로 옮겨 두고 D1 에서는 지운다.
         R2 는 용량 제한이 없고 저장값이 D1 의 몇십 분의 일이다.

         관리자만 부를 수 있다. 한 번에 조금씩만 옮기므로 여러 번 불러도 된다.
         나중에 wrangler.toml 에 크론을 걸면 밤마다 저절로 돌게 할 수 있다.
           curl -X POST https://podotalk-api.hasin7jk.workers.dev/talk/archive \
                -H "X-Admin-Key: (내 관리자 키)"                                */
      if (p === "/talk/archive" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const days = Math.max(7, parseInt(body.days) || 90);
        const limit = Math.min(5000, Math.max(100, parseInt(body.limit) || 2000));
        const cut = Date.now() - days * 86400e3;

        const rows = await env.DB.prepare(
          `SELECT * FROM pt_messages WHERE created<? ORDER BY created ASC LIMIT ?`
        ).bind(cut, limit).all();
        const list = rows.results || [];
        if (!list.length) return json({ ok: true, moved: 0, done: 1 }, env);

        if (env.ARCHIVE) {
          /* 방별로 묶어서 한 덩어리로 넣는다. 파일 수가 적어야 값이 싸다 */
          const byRoom = {};
          for (const m of list) (byRoom[m.room_id] = byRoom[m.room_id] || []).push(m);
          for (const rid of Object.keys(byRoom)) {
            const key = "msg/" + rid + "/" + byRoom[rid][0].created + ".json";
            await env.ARCHIVE.put(key, JSON.stringify(byRoom[rid]),
              { httpMetadata: { contentType: "application/json" } });
          }
        }

        const ids = list.map((m) => m.id);
        for (let i = 0; i < ids.length; i += 100) {
          const part = ids.slice(i, i + 100);
          await env.DB.prepare(
            `DELETE FROM pt_messages WHERE id IN (${part.map(() => "?").join(",")})`
          ).bind(...part).run();
        }
        return json({ ok: true, moved: list.length, archived: !!env.ARCHIVE,
                      done: list.length < limit ? 1 : 0 }, env);
      }

      /* ══ 채팅 번역 ═══════════════════════════════════════════
         지금까지 앱이 구글 무료 번역 주소를 직접 불렀다. 공식 API 가 아니라
         브라우저용 비공식 주소라, 사람이 늘면 반드시 막힌다. 유료 번역 API 는
         100만 자당 $20 이라 규모가 커지면 감당이 안 된다.
         Workers AI 의 전용 번역 모델(m2m100)로 옮긴다. 훨씬 싸고 안 막힌다.

         같은 문장을 여러 사람이 같은 언어로 볼 때가 많으므로 캐시에 담아둔다.
         두 번째부터는 모델을 부르지 않는다. */
      if (p === "/talk/translate" && req.method === "POST") {
        const text = clean(body.text, 1200);
        const to = clean(body.to, 8).toLowerCase() || "ko";
        if (!text) return json({ ok: true, text: "" }, env);

        /* 캐시 — Workers 의 기본 캐시를 쓴다. 표를 새로 만들지 않아도 된다 */
        let ck = null, cache = null;
        try {
          const h = await crypto.subtle.digest("SHA-256", TE.encode(to + "|" + text));
          ck = new Request("https://pt-tr.local/" + bytesToB64u(h));
          cache = caches.default;
          const hit = await cache.match(ck);
          if (hit) {
            const j = await hit.json();
            if (j && j.text) return json({ ok: true, text: j.text, cached: 1 }, env);
          }
        } catch (e) {}

        let out = "";
        /* 전용 번역 모델이 가장 싸고 빠르다 */
        try {
          const src = clean(body.from, 8).toLowerCase() ||
            (/[가-힣]/.test(text) ? "ko" : /[ぁ-んァ-ン]/.test(text) ? "ja" :
             /[\u4e00-\u9fff]/.test(text) ? "zh" : "en");
          if (src !== to) {
            const r = await env.AI.run("@cf/meta/m2m100-1.2b",
              { text, source_lang: src, target_lang: to });
            out = String((r && (r.translated_text || r.response)) || "").trim();
          } else {
            out = text;
          }
        } catch (e) {}

        /* 번역 모델이 그 언어를 모르면 일반 모델로 한 번 더 시도한다 */
        if (!out) {
          out = await runAI(env,
            "Translate the user's message into the language with ISO code '" + to +
            "'. Return ONLY the translation. No quotes, no explanation, no notes.",
            text, { fast: true, max: 500 });
          if (/^AI 응답을 받지/.test(out)) out = "";
        }

        if (out && ck && cache) {
          try {
            ctx.waitUntil(cache.put(ck, new Response(JSON.stringify({ text: out }), {
              headers: { "Content-Type": "application/json", "Cache-Control": "max-age=2592000" }
            })));
          } catch (e) {}
        }
        return json({ ok: !!out, text: out }, env);
      }

      /* ══ 신고 · 차단 · 자동 제한 ═════════════════════════════
         표를 먼저 만들어야 한다 (D1 콘솔) :
           CREATE TABLE IF NOT EXISTS pt_reports (
             id TEXT PRIMARY KEY, target_uid TEXT NOT NULL, by_uid TEXT NOT NULL,
             room_id TEXT, msg_id TEXT, body TEXT, reason TEXT, ts INTEGER);
           CREATE INDEX IF NOT EXISTS pt_reports_t ON pt_reports(target_uid);
           CREATE TABLE IF NOT EXISTS pt_blocks (
             uid TEXT NOT NULL, blocked TEXT NOT NULL, ts INTEGER,
             PRIMARY KEY(uid, blocked));
           CREATE TABLE IF NOT EXISTS pt_bans (
             uid TEXT PRIMARY KEY, until INTEGER, reason TEXT,
             reports INTEGER, ts INTEGER);
         ══════════════════════════════════════════════════════ */

      /* 신고하기 — 신고한 사람에게는 그 즉시 안 보이게 되고,
         쌓이면 사람 손을 거치지 않고 바로 이용이 제한된다. */
      if (p === "/talk/report" && req.method === "POST") {
        const by = clean(body.uid, 64);
        const target = clean(body.target_uid, 64);
        if (!uidOk(by)) return bad("사용자 정보가 없습니다", env);
        if (!uidOk(target)) return bad("신고할 상대를 찾을 수 없습니다", env);
        if (by === target) return bad("자기 자신은 신고할 수 없습니다", env);

        const reason = clean(body.reason, 40) || "기타";
        const msgId = clean(body.msg_id, 64);
        const text = clean(body.body, 500);

        /* 같은 글을 여러 번 눌러도 한 번으로 센다 */
        const dupKey = msgId ? msgId : ("n_" + by + "_" + target);
        const dup = await env.DB.prepare(
          `SELECT id FROM pt_reports WHERE by_uid=? AND target_uid=? AND msg_id=?`
        ).bind(by, target, dupKey).first();
        if (!dup) {
          await env.DB.prepare(
            `INSERT INTO pt_reports(id,target_uid,by_uid,room_id,msg_id,body,reason,ts)
             VALUES(?,?,?,?,?,?,?,?)`
          ).bind(crypto.randomUUID(), target, by, clean(body.room_id, 64), dupKey, text, reason, Date.now()).run();
        }

        /* 신고하면 그 사람 글은 나에게 바로 안 보인다 */
        await env.DB.prepare(
          `INSERT OR IGNORE INTO pt_blocks(uid,blocked,ts) VALUES(?,?,?)`
        ).bind(by, target, Date.now()).run();

        /* ── 자동 조치 ──
           신고된 글 자체가 거래·유인이면 한 건으로도 바로 제한한다.
           그렇지 않으면 최근 30일 안에 서로 다른 사람 3명이 신고했을 때 제한한다. */
        let banned = 0, until = 0, why = "";
        const chk = text ? modCheck(text) : { level: 0 };
        const since = Date.now() - 30 * 86400e3;
        const cnt = await env.DB.prepare(
          `SELECT COUNT(DISTINCT by_uid) AS c FROM pt_reports WHERE target_uid=? AND ts>?`
        ).bind(target, since).first();
        const n = (cnt && cnt.c) || 0;

        if (chk.level === 2) { why = "금지된 내용(" + chk.hit + ")"; until = await modBan(env, target, 30, why, n); banned = 1; }
        else if (n >= 10)    { why = "신고 " + n + "건 누적";        until = await modBan(env, target, 365, why, n); banned = 1; }
        else if (n >= 3)     { why = "신고 " + n + "건 누적";        until = await modBan(env, target, 7, why, n); banned = 1; }

        return json({ ok: true, reports: n, banned, until, reason: why }, env);
      }

      /* 차단 · 차단 풀기 */
      if (p === "/talk/block" && req.method === "POST") {
        const uid = clean(body.uid, 64);
        const target = clean(body.target_uid, 64);
        if (!uidOk(uid) || !uidOk(target)) return bad("차단 정보가 올바르지 않습니다", env);
        if (uid === target) return bad("자기 자신은 차단할 수 없습니다", env);
        if (body.remove) {
          await env.DB.prepare(`DELETE FROM pt_blocks WHERE uid=? AND blocked=?`).bind(uid, target).run();
          return json({ ok: true, blocked: 0 }, env);
        }
        await env.DB.prepare(`INSERT OR IGNORE INTO pt_blocks(uid,blocked,ts) VALUES(?,?,?)`)
          .bind(uid, target, Date.now()).run();
        return json({ ok: true, blocked: 1 }, env);
      }

      /* 내가 차단한 사람 목록 — 이름은 같은 방에서 쓰던 것을 붙여준다 */
      if (p === "/talk/blocks" && req.method === "GET") {
        const uid = q.get("uid") || "";
        if (!uidOk(uid)) return json({ ok: true, blocks: [] }, env);
        const r = await env.DB.prepare(
          `SELECT b.blocked AS uid, b.ts,
                  (SELECT nick FROM pt_members m WHERE m.uid=b.blocked LIMIT 1) AS nick
             FROM pt_blocks b WHERE b.uid=? ORDER BY b.ts DESC LIMIT 200`
        ).bind(uid).all();
        return json({ ok: true, blocks: r.results || [] }, env);
      }

      /* 내 상태 — 제한을 받고 있는지 앱이 물어본다 */
      if (p === "/talk/mystate" && req.method === "GET") {
        const uid = q.get("uid") || "";
        if (!uidOk(uid)) return json({ ok: true, ban: null }, env);
        const b = await modBanned(env, uid);
        return json({ ok: true, ban: b ? { until: b.until, reason: b.reason } : null }, env);
      }

      /* 신고 살펴보기 · 손으로 풀어주기 (관리자) */
      if (p === "/talk/reports" && req.method === "GET") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const r = await env.DB.prepare(
          `SELECT target_uid, COUNT(*) AS n, MAX(ts) AS last,
                  (SELECT reason FROM pt_reports x WHERE x.target_uid=pt_reports.target_uid ORDER BY ts DESC LIMIT 1) AS reason,
                  (SELECT body   FROM pt_reports x WHERE x.target_uid=pt_reports.target_uid ORDER BY ts DESC LIMIT 1) AS body
             FROM pt_reports GROUP BY target_uid ORDER BY last DESC LIMIT 100`
        ).all();
        const b = await env.DB.prepare(`SELECT uid,until,reason FROM pt_bans LIMIT 200`).all();
        return json({ ok: true, reports: r.results || [], bans: b.results || [] }, env);
      }
      if (p === "/talk/ban" && req.method === "POST") {
        if (!isAdmin(req, env)) return bad("관리자 키가 필요합니다", env, 403);
        const target = clean(body.uid, 64);
        if (!uidOk(target)) return bad("대상이 올바르지 않습니다", env);
        if (body.remove) {
          await env.DB.prepare(`DELETE FROM pt_bans WHERE uid=?`).bind(target).run();
          return json({ ok: true, banned: 0 }, env);
        }
        const until = await modBan(env, target, Math.max(1, parseInt(body.days) || 7), clean(body.reason, 120) || "관리자 조치", 0);
        return json({ ok: true, banned: 1, until }, env);
      }

      return bad("없는 경로입니다: " + p, env, 404);
    } catch (e) {
      return json({ ok: false, error: "서버 오류가 발생했습니다", detail: String(e && e.message) }, env, 500);
    }
  },
};