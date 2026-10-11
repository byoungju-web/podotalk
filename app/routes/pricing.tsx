import { json, type MetaFunction } from '@remix-run/cloudflare';
import { useEffect, useState } from 'react';
import { ClientOnly } from 'remix-utils/client-only';
import { Header } from '~/components/header/Header';

export const meta: MetaFunction = () => {
  return [{ title: '요금제 · coverfo' }, { name: 'description', content: 'coverfo 요금제 안내' }];
};

export const loader = () => json({});

interface Plan {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  highlight: boolean;
  note?: string;
}

const PLANS: Plan[] = [
  {
    name: '무료',
    price: '0원',
    period: '',
    description: '가입하면 무료 크레딧 4가 한 번 지급됩니다. 무료 크레딧을 다 쓰면 그다음부터는 충전 크레딧이 차감됩니다.',
    features: [
      '무료 크레딧 4 (가입 시 1회) — chat 답변 20번',
      '무료 크레딧은 매달 전체 4,000크레딧 한도(약 1,000명분) 안에서 선착순 · 매달 1일 다시 열림',
      '무료 크레딧 제공은 2027년 1월 31일까지',
      '영상은 충전 크레딧으로만 가능',
    ],
    highlight: false,
  },
  {
    name: '스타터',
    price: '9,900원',
    period: '/ 100크레딧',
    description: '충전한 크레딧으로 쓴 만큼만 차감됩니다. 기간 제한 없이 남은 크레딧은 그대로 남습니다.',
    features: [
      'chat 답변 1회 0.2크레딧 (1크레딧으로 5번 · 웹검색 포함)',
      '앱 생성(chat) 1회 8크레딧',
      '사진으로 물어보기 1장 1크레딧 (이어서 질문 3개 포함, 그 뒤 1크레딧에 5개)',
      '이미지 2K 생성 2크레딧',
      '영상 8초 25크레딧',
      'coverfo 엔진 · 앱 만들기 30크레딧',
      'coverfo 엔진 · 3D 에셋(이미지·영상·3D 모델) 25크레딧',
      '엔진 결과 수정 5크레딧부터 (이미지 8 · 3D 모델 15 · 영상 15)',
      '300크레딧 29,000원 · 550크레딧 49,000원 (10% 더) · 1,200크레딧 99,000원 (20% 더)',
      '포도톡 · 포도야에 연결하면 같은 크레딧으로 씁니다 (1크레딧 = 99원)',
    ],
    highlight: true,
  },
  {
    name: '작동 방식',
    price: '1크레딧 ≈ 99원',
    period: '',
    description: '가입하고 바로 씁니다. 쓴 만큼만 크레딧이 차감되고, 따로 준비할 것은 없습니다.',
    features: ['API 키 발급 · 관리 불필요', '실패한 생성은 자동 환불', '만든 결과물은 그대로 사용'],
    highlight: false,
    note: '결제 즉시 자동으로 충전됩니다. 계좌이체 문의도 가능합니다.',
  },
];

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={
        plan.highlight
          ? 'flex flex-col rounded-xl border-2 border-accent-500 bg-bolt-elements-background-depth-2 p-6'
          : 'flex flex-col rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-6'
      }
    >
      {plan.highlight && (
        <span className="mb-3 self-start rounded-full bg-accent-500 px-3 py-1 text-xs font-medium text-white">
          가장 많이 쓰는 요금제
        </span>
      )}

      <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">{plan.name}</h2>

      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-bolt-elements-textPrimary">{plan.price}</span>
        <span className="text-sm text-bolt-elements-textSecondary">{plan.period}</span>
      </div>

      <p className="mt-3 text-sm text-bolt-elements-textSecondary">{plan.description}</p>

      <ul className="mt-5 flex flex-col gap-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2 text-sm text-bolt-elements-textPrimary">
            <span className="text-accent-500">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {plan.note && <p className="mt-4 text-xs text-bolt-elements-textSecondary">{plan.note}</p>}

      <div className="mt-6">
        {plan.highlight ? (
          <a
            href="#charge"
            className="block rounded-lg bg-accent-500 px-4 py-2.5 text-center text-sm font-medium text-white"
          >
            충전하기 (카드 · 계좌이체 · 간편결제)
          </a>
        ) : (
          <a
            href="/"
            className="block rounded-lg border border-bolt-elements-borderColor px-4 py-2.5 text-center text-sm font-medium text-bolt-elements-textPrimary"
          >
            바로 써보기
          </a>
        )}
      </div>
    </div>
  );
}

/* 충전 · 포도톡 연결 — /buy 와 같은 서버(/api/pay · /api/wallet)를 쓰는 화면. 결제창(토스)은 이 페이지에서 바로 열린다 */
type Pkg = { id: string; credits: number; amount: number };
type Cfg = { enabled?: boolean; clientKey?: string; packages?: Pkg[]; testMode?: boolean };
type Me = { email?: string; free?: number; paid?: number; orders?: any[] };

const METHODS: [string, string][] = [
  ['CARD', '💳 카드 · 간편결제'],
  ['TRANSFER', '🏦 계좌이체'],
  ['MOBILE_PHONE', '📱 휴대폰'],
];

function won(n: number) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

function loadToss(): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = window as any;

    if (w.TossPayments) {
      resolve(w.TossPayments);
      return;
    }

    const sc = document.createElement('script');
    sc.src = 'https://js.tosspayments.com/v2/standard';
    sc.onload = () => resolve(w.TossPayments);
    sc.onerror = () => reject(new Error('결제 모듈을 불러오지 못했습니다'));
    document.head.appendChild(sc);
  });
}

function ChargeBox() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [token, setToken] = useState<string>('');
  const [me, setMe] = useState<Me | null>(null);
  const [pkg, setPkg] = useState<string>('');
  const [method, setMethod] = useState<string>('CARD');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ t: string; h: string } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [wmsg, setWmsg] = useState('');

  const api = (m: string, qs: string, body?: any) =>
    fetch('/api/pay' + qs, {
      method: m,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json().then((j: any) => ({ ...j, __status: r.status })));
  const wapi = (body: any) =>
    fetch('/api/wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((j: any) => ({ ...j, __status: r.status })));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c: Cfg = await fetch('/api/pay?config=1').then((r) => r.json());

        if (!alive) {
          return;
        }

        setCfg(c);
        setPkg((c.packages || []).find((x) => x.id === 'plus')?.id || (c.packages || [])[1]?.id || (c.packages || [])[0]?.id || ''); // 기본 선택: 550(plus)

        if (!c.enabled) {
          setMsg({ t: 'info', h: '결제 준비 중입니다. 지금은 이메일(hasin7jk@gmail.com) 문의로 충전해 드립니다.' });
        }

        const { supabase } = await import('~/lib/supabaseClient');
        const { data } = await supabase.auth.getSession();
        const t = data?.session?.access_token || '';

        if (alive) {
          setToken(t);
        }
      } catch (e: any) {
        setMsg({ t: 'err', h: '설정을 불러오지 못했습니다: ' + String(e?.message || e) });
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    api('GET', '?me=1').then((j: any) => {
      if (j.__status === 200) {
        setMe(j);
      }
    });
    wapi({ op: 'balance' }).then((j: any) => {
      if (j.__status === 200) {
        setCode(j.code || null);
      }
    });
  }, [token]);

  const pay = async () => {
    const p = (cfg?.packages || []).find((x) => x.id === pkg);

    if (busy || !p || !token || !cfg?.clientKey) {
      return;
    }

    setBusy(true);
    setMsg({ t: 'info', h: '결제창을 여는 중입니다…' });

    try {
      const j: any = await api('POST', '', { op: 'create', package: p.id });

      if (j.__status !== 200) {
        throw new Error(j.error || '주문 생성 실패');
      }

      const TossPayments = await loadToss();
      const payment = TossPayments(cfg.clientKey).payment({ customerKey: j.customerKey });
      await payment.requestPayment({
        method,
        amount: { currency: 'KRW', value: j.amount },
        orderId: j.orderId,
        orderName: j.orderName,
        successUrl: location.origin + '/api/pay?op=confirm',
        failUrl: location.origin + '/buy?fail=' + encodeURIComponent('결제가 취소되었거나 실패했습니다'),
        customerEmail: j.email || undefined,
      });
    } catch (e: any) {
      setMsg({ t: 'err', h: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const makeCode = async () => {
    if (code && !confirm('새 코드를 만들면 지금 코드로 연결된 포도톡은 끊깁니다. 다시 넣어야 해요. 계속할까요?')) {
      return;
    }

    const j: any = await wapi({ op: code ? 'newcode' : 'code' });

    if (j.__status !== 200) {
      setWmsg(j.error || '실패');
      return;
    }

    setCode(j.code);
    setWmsg('코드를 만들었습니다. 포도톡 설정 → 크레딧 지갑 → coverfo 지갑에 연결하기 칸에 넣어 주세요.');
  };
  const unlink = async () => {
    if (!confirm('연결을 끊으면 포도톡은 다시 자체 지갑을 씁니다. 계속할까요?')) {
      return;
    }

    const j: any = await wapi({ op: 'unlink' });
    setCode(j.__status === 200 ? null : code);
    setWmsg(j.__status === 200 ? '연결을 끊었습니다.' : j.error || '실패');
  };
  const copy = async () => {
    if (!code) {
      setWmsg('먼저 코드를 만들어 주세요.');
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setWmsg('복사했습니다: ' + code);
    } catch {
      setWmsg('복사가 안 되면 길게 눌러 복사해 주세요: ' + code);
    }
  };

  const chosen = (cfg?.packages || []).find((x) => x.id === pkg);
  const msgCls =
    msg?.t === 'err' ? 'bg-red-50 text-red-700' : msg?.t === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700';

  const fmt1 = (n: number) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  return (
    <div className="flex flex-col gap-5">
      {/* v209 내 크레딧 잔액 — 이 화면을 열면 가장 먼저 보이게 맨 위에 둔다 */}
      <div className="rounded-xl border-2 border-indigo-600 bg-bolt-elements-background-depth-2 p-5">
        <div className="text-sm font-semibold text-bolt-elements-textPrimary">💜 내 크레딧</div>
        {token ? (
          <>
            <div className="mt-2 text-center text-xs text-bolt-elements-textSecondary">남은 크레딧</div>
            <div className="text-center text-4xl font-extrabold text-indigo-700">{me ? fmt1((me.free || 0) + (me.paid || 0)) : '…'}</div>
            <div className="mt-1 text-center text-xs text-bolt-elements-textSecondary">
              {me ? '무료 ' + fmt1(me.free || 0) + ' · 충전 ' + fmt1(me.paid || 0) + ' (≈ ' + won(Math.round((me.paid || 0) * 99)) + ') · 1크레딧 = 99원' : '불러오는 중…'}
            </div>
            <div className="mt-3 text-xs leading-relaxed text-bolt-elements-textSecondary">
              {me?.email ? me.email + ' · ' : ''}coverfo · 포도톡 · 포도야 어디서 써도 같은 지갑입니다. 충전·환불은 coverfo 에서 합니다. (포도톡·포도야는 충전 크레딧만 씁니다)
            </div>
          </>
        ) : (
          <div className="mt-2 text-sm text-bolt-elements-textSecondary">
            로그인하면 내 크레딧 잔액이 여기에 보입니다.{' '}
            <a href="/" className="font-medium underline">
              홈으로 가서 로그인
            </a>
          </div>
        )}
      </div>

      <div>
        <h2 className="text-base font-semibold text-bolt-elements-textPrimary">충전 · 포도톡 연결</h2>
        <p className="mt-1 text-sm text-bolt-elements-textSecondary">
          여기서 바로 충전하고, 포도톡·포도야에 연결하는 코드도 만듭니다. 1크레딧 = 99원, 세 서비스가 같은 지갑을 씁니다.
        </p>
      </div>

      {cfg?.testMode ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">🧪 테스트 결제 모드 — 실제 돈은 빠져나가지 않습니다.</div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(cfg?.packages || []).map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPkg(p.id)}
            className={
              'rounded-xl border p-4 text-left transition ' +
              (pkg === p.id ? 'border-indigo-500 ring-2 ring-indigo-200' : 'border-bolt-elements-borderColor')
            }
          >
            {p.id === 'plus' || (!(cfg?.packages || []).some((x) => x.id === 'plus') && i === 1) ? (
              <span className="mb-1 inline-block rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">가장 많이 선택</span>
            ) : null}
            <div className="text-2xl font-bold text-bolt-elements-textPrimary">
              {p.credits.toLocaleString()} <span className="text-xs font-medium text-bolt-elements-textSecondary">크레딧</span>
            </div>
            <div className="text-sm font-semibold text-bolt-elements-textPrimary">{won(p.amount)}</div>
            <div className="text-xs text-bolt-elements-textSecondary">1크레딧당 {Math.round(p.amount / p.credits)}원</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {METHODS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMethod(k)}
            className={
              'rounded-full border px-3 py-1.5 text-sm font-medium ' +
              (method === k ? 'border-black bg-black text-white' : 'border-bolt-elements-borderColor text-bolt-elements-textPrimary')
            }
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={pay}
        disabled={busy || !token || !chosen || !cfg?.enabled}
        className="rounded-full bg-indigo-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {chosen ? won(chosen.amount) + ' 결제하기 (' + chosen.credits.toLocaleString() + '크레딧)' : '패키지를 골라 주세요'}
      </button>
      {msg ? <div className={'rounded-lg px-3 py-2 text-sm ' + msgCls} dangerouslySetInnerHTML={{ __html: msg.h }} /> : null}

      {token ? (
        <div className="rounded-xl border border-bolt-elements-borderColor p-4">
          <div className="text-sm font-semibold text-bolt-elements-textPrimary">🍇 포도톡 · 포도야에 연결</div>
          <p className="mt-1 text-xs text-bolt-elements-textSecondary">
            아래 코드를 포도톡 <b>설정 → 크레딧 지갑 → coverfo 지갑에 연결하기</b> 칸에 넣으면 포도톡(포도야 포함)이 이 크레딧을 같이 씁니다. 계정마다 코드는 하나이고,
            다시 만들면 옛 코드는 꺼집니다. coverfo 홈 안에서 포도톡을 열면 코드 없이 자동 연결됩니다.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={code || ''}
              placeholder="아직 코드가 없습니다"
              className="h-11 flex-1 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-center text-base font-bold tracking-wider text-bolt-elements-textPrimary"
            />
            <button type="button" onClick={copy} className="h-11 rounded-lg bg-indigo-700 px-4 text-sm font-semibold text-white">
              복사
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={makeCode} className="h-11 flex-1 rounded-lg bg-black text-sm font-semibold text-white">
              {code ? '코드 다시 만들기' : '코드 만들기'}
            </button>
            {code ? (
              <button type="button" onClick={unlink} className="h-11 flex-1 rounded-lg bg-gray-200 text-sm font-semibold text-gray-800">
                연결 끊기
              </button>
            ) : null}
          </div>
          {wmsg ? <div className="mt-2 text-xs text-bolt-elements-textSecondary">{wmsg}</div> : null}
          <div className="mt-2 text-xs text-bolt-elements-textSecondary">
            1크레딧 = 99원 · 받아쓰기 0.1 · 빠른 답 0.2 · 웹검색 0.4 · 고품질 답 0.8 · 전화통역 6/분 — 어디서 써도 같은 지갑입니다. 포도톡 크레딧 10 = coverfo 크레딧 1 (같은 금액)이라, 포도톡에 남은 크레딧을 먼저 쓰고 그다음 이 지갑에서 나갑니다.
          </div>
        </div>
      ) : null}

      {me?.orders?.length ? (
        <div>
          <div className="mb-2 text-sm font-semibold text-bolt-elements-textPrimary">충전 내역</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-bolt-elements-textSecondary">
                <th className="py-1">날짜</th>
                <th className="py-1">크레딧</th>
                <th className="py-1">금액</th>
                <th className="py-1">상태</th>
              </tr>
            </thead>
            <tbody>
              {me.orders.map((o: any, i: number) => {
                const d = new Date(o.paid_at || o.created_at);
                const label =
                  (({ paid: '완료', manual: '수동 충전', pending: '미완료', failed: '실패', canceled: '취소', refunded: '환불 완료' } as any)[o.status] || o.status) +
                  (o.status === 'refunded' && o.fee > 0 ? ` (수수료 ${won(o.fee)})` : '');

                return (
                  <tr key={i} className="border-t border-bolt-elements-borderColor text-bolt-elements-textPrimary">
                    <td className="py-1.5">{d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-1.5">{(o.credits > 0 ? '+' : '') + o.credits}</td>
                    <td className="py-1.5">{o.amount ? won(o.amount) : '-'}</td>
                    <td className="py-1.5">{label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export default function Pricing() {
  return (
    <div className="flex min-h-full w-full flex-col bg-bolt-elements-background-depth-1">
      <ClientOnly>{() => <Header />}</ClientOnly>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {/* v209 순서: 내 크레딧 잔액 → 충전(패키지·결제) → 포도톡 연결 → 요금제 */}
        <div id="charge" className="scroll-mt-16 rounded-xl border border-bolt-elements-borderColor p-4 sm:p-6">
          <ClientOnly fallback={<div className="py-6 text-center text-sm text-bolt-elements-textSecondary">내 크레딧 불러오는 중…</div>}>
            {() => <ChargeBox />}
          </ClientOnly>
        </div>

        <div className="mt-12 text-center">
          <h1 className="text-2xl font-bold text-bolt-elements-textPrimary sm:text-3xl">요금제</h1>
          <p className="mt-3 text-sm text-bolt-elements-textSecondary">
            무료 크레딧으로 먼저 써보시고, 계속 쓰실 때 충전하시면 됩니다.
          </p>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-bolt-elements-borderColor p-6">
          <h2 className="text-base font-semibold text-bolt-elements-textPrimary">자주 묻는 질문</h2>

          <dl className="mt-4 flex flex-col gap-5">
            <div>
              <dt className="text-sm font-medium text-bolt-elements-textPrimary">무료 크레딧은 어떻게 쓰이나요?</dt>
              <dd className="mt-1 text-sm text-bolt-elements-textSecondary">
                계정을 만들면 무료 크레딧 4가 한 번 지급됩니다. 기능을 쓸 때마다 무료 크레딧부터 차감되고(chat 답변 0.2 — 1크레딧으로 5번, 사진으로
                물어보기 1, 이미지 2, 앱 생성 8, 엔진 앱 30 · 3D 에셋 25), 다 쓰면 충전 크레딧에서 차감됩니다. 만든 결과물을 보는 것은
                차감되지 않습니다. 무료 크레딧은 매달 전체 4,000크레딧 한도(약 1,000명분) 안에서 선착순으로 쓰이며 매달 1일 다시 열리고,
                2027년 1월 31일까지 제공됩니다. 영상은 충전한 크레딧으로만 만들 수 있습니다.
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-bolt-elements-textPrimary">만든 페이지는 제 것인가요?</dt>
              <dd className="mt-1 text-sm text-bolt-elements-textSecondary">
                네. 만들어진 코드와 페이지, 이미지, 영상은 그대로 쓰시면 됩니다.
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-bolt-elements-textPrimary">API 키를 따로 넣어야 하나요?</dt>
              <dd className="mt-1 text-sm text-bolt-elements-textSecondary">
                아니요. 가입 후 바로 쓸 수 있고 크레딧만 차감됩니다. 생성이 실패하면 그 크레딧은 자동으로 환불됩니다.
              </dd>
            </div>
          </dl>
        </div>

        <p className="mt-8 text-center text-xs text-bolt-elements-textSecondary">
          문의: hasin7jk@gmail.com · 표시된 금액은 부가세 포함입니다.
        </p>
      </main>
    </div>
  );
}
