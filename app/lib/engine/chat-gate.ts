/*
 * coverfo 채팅 요금 문지기 (서버 전용) — 2026-10-10
 *
 * 왜 서버에서?
 *   예전에는 화면(Chat.client.tsx)이 보내기 전에 /api/chat-quota 로 횟수를 세었고, /api/chat 자체는 아무 확인도 하지 않았습니다.
 *   그래서 화면을 거치지 않고 /api/chat 을 직접 부르면 로그인 없이, 한도 없이 coverfo 의 AI 키로 쓸 수 있었습니다.
 *   이제 /api/chat 이 요청마다 여기서 로그인·무료 횟수·크레딧을 직접 확인합니다. (화면은 더 이상 횟수를 세지 않음 → 두 번 세지 않음)
 *
 * 규칙 (v206, 2026-10-10 변경: chat 무료 횟수 없앰)
 *   · 로그인 필수 (Authorization: Bearer <Supabase 로그인 토큰>)
 *   · 글 답변(discuss): 1회마다 크레딧 COST_CHAT(기본 1) 차감. 무료 횟수는 없음.
 *       크레딧은 Supabase 함수 cf_spend 가 무료 크레딧(가입 4)부터 쓰고, 없으면 충전 크레딧에서 뺌
 *       → 새 가입자는 4번째 답까지 무료 크레딧, 5번째부터 충전 크레딧 (화면에 안내 문구)
 *   · v210 (2026-10-11): 글 답변은 1회 0.2크레딧 (≈20원).
 *       글 답변은 저가 모델(gpt-6-luna)이라 1회 원가가 2~4원, 웹검색(Brave)이 붙으면 약 7원 더 (≈ 최대 11원).
 *       1크레딧(99원)은 너무 비쌌고, 0.1(≈10원)은 웹검색 답에서 밑지므로 0.2 로 정함.
 *       크레딧은 정수로만 차감되므로 "묶음" 으로 처리: 1크레딧을 차감하면 답변 5회(CHAT_PACK) 가 열리고,
 *       묶음이 남아 있는 동안은 차감 없이 하나씩 씀 → 결과적으로 1회 0.2크레딧. 가입 무료 4크레딧 = 답변 20회.
 *       횟수는 Cloudflare 변수 CHAT_PACK 으로 바꿀 수 있음 (기본 5).
 *       답을 못 만들면 묶음 1회를 되돌려 줌 (크레딧 손해 없음).
 *       표·함수는 sql/cf_chat_pack.sql (Supabase 에서 Run 1회). 아직 안 돌렸으면 예전처럼 1회 1크레딧으로 동작.
 *   · 앱 생성(build)  : 매번 크레딧 COST_CHAT_BUILD(기본 8) 차감
 *   · 크레딧이 부족하면 402 로 막습니다. 답을 만들다 실패하면 크레딧을 돌려줍니다(cf_refund).
 *   · Supabase 설정이 아예 없는 개발 환경에서만 검사 없이 통과합니다.
 */
import { getUserId, supabaseAuthConfig } from '~/lib/engine/server';

type Env = Record<string, any>;
type SB = { url: string; service: string };

export type ChatCharge = {
  userId: string;
  mode: 'discuss' | 'build';
  free: boolean; // 무료 횟수로 처리됨 (v206 부터 글 답변은 항상 false)
  freeLeft: number | null; // (v206 부터 쓰지 않음)
  usedFree: number; // 이번에 쓴 무료 크레딧
  usedPaid: number; // 이번에 쓴 충전 크레딧
  note: string; // cf_spend 가 알려 준 사유 (free_closed: 무료 기간 끝 · pool_exhausted: 이달 무료 한도 소진)
  cost: number; // 이번에 차감한 크레딧 (무료면 0)
  pack: { bought: boolean; left: number; size: number; src: string } | null; // v210 답변 묶음 (없으면 null = 예전 방식)
  jobId: string | null;
  balance: { free: number; paid: number } | null;
};

function sb(env: Env): SB | null {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const service = String(env.SUPABASE_SERVICE_ROLE_KEY || '');

  return url && service ? { url, service } : null;
}

async function rpc(c: SB, name: string, args: any) {
  const r = await fetch(`${c.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: c.service, Authorization: `Bearer ${c.service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  const t = await r.text();

  if (!r.ok) {
    throw new Error(`supabase rpc ${name} ${r.status}: ${t.slice(0, 200)}`);
  }

  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function num(env: Env, k: string, d: number) {
  const v = parseInt(String(env[k] ?? ''), 10);
  return Number.isFinite(v) && v >= 0 ? v : d;
}

/* 화면(Chat.client handleError)이 읽는 모양: { error, code, message, statusCode, isRetryable } */
function deny(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: true, code, message, statusCode: status, isRetryable: false, ...(extra || {}) }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* 크레딧 차감 — 엔진·렌즈와 같은 방식: kind 허용 목록에 걸리면 'chat' 으로 한 번 더 */
async function spend(c: SB, userId: string, cost: number, kind: string, prompt: string) {
  try {
    return await rpc(c, 'cf_spend', { p_user: userId, p_cost: cost, p_kind: kind, p_prompt: prompt });
  } catch {
    return await rpc(c, 'cf_spend', { p_user: userId, p_cost: cost, p_kind: 'chat', p_prompt: prompt });
  }
}

/* 차감 전 잔액 (cf_credits: free_balance = 무료, balance = 충전). 못 읽으면 null */
async function balanceOf(c: SB, userId: string): Promise<{ free: number; paid: number } | null> {
  try {
    const r = await fetch(`${c.url}/rest/v1/cf_credits?select=free_balance,balance&user_id=eq.${encodeURIComponent(userId)}&limit=1`, {
      headers: { apikey: c.service, Authorization: `Bearer ${c.service}` },
    });
    const rows: any[] = r.ok ? await r.json() : [];

    return rows && rows[0] ? { free: Number(rows[0].free_balance || 0), paid: Number(rows[0].balance || 0) } : { free: 0, paid: 0 };
  } catch {
    return null;
  }
}

/** 통과하면 { charge }, 막으면 { deny: Response } */
export async function chatGate(
  request: Request,
  env: Env,
  mode: 'discuss' | 'build',
): Promise<{ charge: ChatCharge | null; deny?: Response }> {
  const c = sb(env);

  // Supabase 가 아예 설정되지 않은 개발 환경만 통과 (운영 coverfo 에는 둘 다 있음)
  if (!c && !supabaseAuthConfig(env)) {
    return { charge: null };
  }

  if (!c) {
    return { charge: null, deny: deny(503, 'off', '지금은 채팅을 쓸 수 없어요. 잠시 뒤 다시 해 주세요.') };
  }

  const user = await getUserId(request, env).catch(() => null);

  if (!user) {
    return { charge: null, deny: deny(401, 'login', '로그인이 필요합니다. 홈에서 로그인한 뒤 다시 보내 주세요.') };
  }

  // ── v210 글 답변 묶음: 남은 묶음이 있으면 차감 없이 1회 사용 ──
  const packSize = Math.max(1, num(env, 'CHAT_PACK', 5));
  let packOn = false; // 묶음 표·함수가 있는지 (sql/cf_chat_pack.sql)

  if (mode === 'discuss') {
    const t: any = await rpc(c, 'cf_chat_pack_take', { p_user: user.id }).catch(() => null);

    if (t && typeof t === 'object' && 'ok' in t) {
      packOn = true;

      if (t.ok) {
        return {
          charge: {
            userId: user.id,
            mode,
            free: false,
            freeLeft: null,
            cost: 0,
            jobId: null,
            balance: await balanceOf(c, user.id),
            usedFree: 0,
            usedPaid: 0,
            note: '',
            pack: { bought: false, left: Number(t.left || 0), size: packSize, src: String(t.src || '') },
          },
        };
      }
    }
  }

  // ── 크레딧 차감 (글 답변 1 = 묶음 5회 / 앱 생성 8) — 무료 크레딧부터 쓰는 것은 cf_spend 가 정함 ──
  const cost = mode === 'build' ? num(env, 'COST_CHAT_BUILD', 8) : num(env, 'COST_CHAT', 1);
  const kind = mode === 'build' ? 'chat_build' : 'chat';
  const before = await balanceOf(c, user.id); // 무료·충전 중 무엇을 썼는지 안내하려고 차감 전 잔액을 봐 둠
  const s: any = await spend(c, user.id, cost, kind, mode === 'build' ? '[chat] 앱 생성' : '[chat] 글 답변').catch(() => null);

  if (!s) {
    return { charge: null, deny: deny(500, 'credit_error', '크레딧 확인에 실패했어요. 잠시 뒤 다시 해 주세요.') };
  }

  if (!s.ok) {
    const msg =
      mode === 'build'
        ? `크레딧이 부족해요. 앱 생성은 1회 ${cost}크레딧이에요. 충전 후 이용해 주세요. (coverfo.com/pricing)`
        : packOn
          ? `크레딧이 부족해요. chat 답변은 크레딧 ${cost}로 ${packSize}회(1회 ${Math.round((cost / packSize) * 100) / 100}크레딧)예요. 충전 후 이용해 주세요. (coverfo.com/pricing)`
          : `크레딧이 부족해요. chat 답변은 1회 ${cost}크레딧이에요(무료 크레딧을 다 쓰면 충전 크레딧에서 차감). 충전 후 이용해 주세요. (coverfo.com/pricing)`;

    return { charge: null, deny: deny(402, 'insufficient', msg, { need: cost, free: s.free ?? 0, paid: s.paid ?? 0 }) };
  }

  const usedFree = before ? Math.max(0, before.free - Number(s.free || 0)) : 0;
  let pack: ChatCharge['pack'] = null;

  // v210 묶음을 새로 엶: 이번 답 1회는 지금 쓰고 나머지(packSize-1)를 넣어 둠
  if (packOn && mode === 'discuss') {
    const src = usedFree > 0 ? 'free' : 'paid';
    const f: any = await rpc(c, 'cf_chat_pack_fill', { p_user: user.id, p_n: packSize - 1, p_src: src }).catch(() => null);
    pack = { bought: true, left: f && f.ok ? Number(f.left || 0) : 0, size: packSize, src };
  }

  return {
    charge: {
      userId: user.id,
      mode,
      free: false,
      freeLeft: null,
      cost,
      pack,
      jobId: s.job_id ?? null, // 묶음(pack)이 있으면 실패 때 크레딧 대신 묶음 1회를 되돌림 (chatGateUndoer)
      balance: { free: Number(s.free || 0), paid: Number(s.paid || 0) },
      usedFree,
      usedPaid: before ? Math.max(0, before.paid - Number(s.paid || 0)) : 0,
      note: String(s.note || ''),
    },
  };
}

/** 답을 만들지 못했을 때 되돌리기 (크레딧 환불 / 무료 횟수 1 되돌림). 여러 번 불려도 한 번만 실행 */
export function chatGateUndoer(env: Env, charge: ChatCharge | null) {
  let done = false;

  return async () => {
    if (done || !charge) {
      return;
    }

    done = true;

    const c = sb(env);

    if (!c) {
      return;
    }

    try {
      if (charge.pack) {
        await rpc(c, 'cf_chat_pack_undo', { p_user: charge.userId }); // v210 묶음 1회 되돌림
      } else if (charge.jobId) {
        await rpc(c, 'cf_refund', { p_job: charge.jobId });
      } else if (charge.free && charge.mode === 'discuss') {
        await rpc(c, 'cf_chat_quota_undo', { p_user: charge.userId });
      }
    } catch {
      // 되돌리기 실패는 답 흐름을 막지 않음
    }
  };
}

/** 답이 끝까지 만들어졌을 때 (작업 기록을 '완료'로) */
export async function chatGateDone(env: Env, charge: ChatCharge | null) {
  const c = sb(env);

  if (!c || !charge || !charge.jobId) {
    return;
  }

  await fetch(`${c.url}/rest/v1/cf_jobs?id=eq.${encodeURIComponent(String(charge.jobId))}`, {
    method: 'PATCH',
    headers: { apikey: c.service, Authorization: `Bearer ${c.service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', updated_at: new Date().toISOString() }),
  }).catch(() => undefined);
}

/** 글 답변(discuss)은 서버가 정한 저가 모델로만 (화면 규칙과 같음 — 직접 호출로 비싼 모델을 쓰지 못하게)
 *  Cloudflare 변수 CHAT_DISCUSS_MODEL / CHAT_DISCUSS_PROVIDER 로 바꿀 수 있음 (기본 gpt-6-luna / OpenAI) */
export function forceDiscussModel(messages: any[], env: Env) {
  const model = String(env.CHAT_DISCUSS_MODEL || 'gpt-6-luna');
  const provider = String(env.CHAT_DISCUSS_PROVIDER || 'OpenAI');
  const prefix = `[Model: ${model}]\n\n[Provider: ${provider}]\n\n`;
  const strip = (s: string) =>
    String(s || '')
      .replace(/^\s*\[Model: .*?\]\n\n/, '')
      .replace(/^\s*\[Provider: .*?\]\n\n/, '');

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    if (!m || m.role !== 'user') {
      continue;
    }

    if (typeof m.content === 'string') {
      m.content = prefix + strip(m.content);
    } else if (Array.isArray(m.content)) {
      const t = m.content.find((x: any) => x && x.type === 'text');

      if (t) {
        t.text = prefix + strip(t.text);
      }
    }

    if (Array.isArray(m.parts)) {
      const p = m.parts.find((x: any) => x && x.type === 'text');

      if (p) {
        p.text = prefix + strip(p.text);
      }
    }

    break;
  }
}
