-- coverfo chat 답변 묶음 (v210, 2026-10-11) — Supabase SQL Editor 에 전체를 붙여넣고 Run 1회
-- 규칙: chat 글 답변 1회 = 0.2크레딧 (웹검색 비용 포함).
--   크레딧은 정수로 차감되므로, 1크레딧을 차감할 때 답변 5회짜리 "묶음"을 열고
--   묶음이 남아 있는 동안은 차감 없이 1회씩 씁니다. (가입 무료 4크레딧 = 답변 20회)
--   몇 회짜리 묶음인지는 서버(Cloudflare 변수 CHAT_PACK, 기본 5)가 정합니다.
--   답을 못 만들면 묶음 1회를 되돌립니다.
-- 이 SQL 을 실행하기 전에는 서버가 예전처럼 1회 1크레딧으로 동작합니다 (막히지 않음).
-- 기존 표·함수(cf_credits, cf_spend …)는 건드리지 않습니다.

-- 1) 사람마다 남은 답변 횟수
create table if not exists public.cf_chat_pack (
  user_id     uuid primary key,
  left_n      integer not null default 0,     -- 남은 답변 횟수
  src         text,                           -- 마지막 묶음을 연 크레딧: free | paid
  updated_at  timestamptz not null default now()
);
alter table public.cf_chat_pack enable row level security;   -- 서버(service_role)만

-- 2) 1회 쓰기: 남아 있으면 1 줄이고 {ok:true, left, src}, 없으면 {ok:false, left:0}
create or replace function public.cf_chat_pack_take(p_user uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_left integer; v_src text;
begin
  update public.cf_chat_pack
     set left_n = left_n - 1, updated_at = now()
   where user_id = p_user and left_n > 0
  returning left_n, src into v_left, v_src;

  if v_left is null then
    return json_build_object('ok', false, 'left', 0);
  end if;

  return json_build_object('ok', true, 'left', v_left, 'src', v_src);
end
$$;

-- 3) 묶음 넣기 (서버가 1크레딧을 차감한 직후, 이번 1회를 뺀 나머지 9회)
create or replace function public.cf_chat_pack_fill(p_user uuid, p_n integer, p_src text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_left integer;
begin
  if p_n is null or p_n < 0 or p_n > 1000 then
    return json_build_object('ok', false, 'reason', 'bad_n');
  end if;

  insert into public.cf_chat_pack (user_id, left_n, src, updated_at)
  values (p_user, p_n, p_src, now())
  on conflict (user_id) do update
    set left_n = public.cf_chat_pack.left_n + excluded.left_n, src = excluded.src, updated_at = now()
  returning left_n into v_left;

  return json_build_object('ok', true, 'left', v_left);
end
$$;

-- 4) 되돌리기 (답을 못 만들었을 때 1회 돌려줌)
create or replace function public.cf_chat_pack_undo(p_user uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare v_left integer;
begin
  insert into public.cf_chat_pack (user_id, left_n, updated_at)
  values (p_user, 1, now())
  on conflict (user_id) do update set left_n = public.cf_chat_pack.left_n + 1, updated_at = now()
  returning left_n into v_left;

  return json_build_object('ok', true, 'left', v_left);
end
$$;

-- 5) 서버(서비스 키)만 부를 수 있게: 브라우저(anon·로그인 사용자)는 직접 못 부름
revoke all on function public.cf_chat_pack_take(uuid) from public, anon, authenticated;
revoke all on function public.cf_chat_pack_fill(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.cf_chat_pack_undo(uuid) from public, anon, authenticated;
grant execute on function public.cf_chat_pack_take(uuid) to service_role;
grant execute on function public.cf_chat_pack_fill(uuid, integer, text) to service_role;
grant execute on function public.cf_chat_pack_undo(uuid) to service_role;

-- 확인용 (선택): 내 남은 답변 횟수 — '내-사용자-id' 를 바꿔서
-- select left_n, src from public.cf_chat_pack where user_id = '내-사용자-id';
