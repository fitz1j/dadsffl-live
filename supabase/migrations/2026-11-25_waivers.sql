-- DadsFFL — waiver wire (web/waivers.html), 2026-11-25
--
-- Rule Book III (Sep 2026). Order, validation and resolution run in the page
-- (web/waiver-engine.js); the database stores who is who, the deadlines, each
-- team's ranked claims and the commissioner's coin tosses, and enforces:
--   * a GM can only see / change their own team's claims before the deadline,
--   * nobody can change claims after the deadline,
--   * everyone can read every team's claims once the deadline has passed.
--
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run. Then fill in league_members (section 6 at the bottom).

-- 1. Who is who -------------------------------------------------------------
create table if not exists public.league_members (
  email            text primary key check (email = lower(email)),
  team             text check (team in ('PD','OS','FAB','WILD','SV','RHR','COM','NUTS')),
  is_commissioner  boolean not null default false
);
alter table public.league_members enable row level security;
drop policy if exists "league_members self" on public.league_members;
create policy "league_members self" on public.league_members for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));
grant select on public.league_members to authenticated;

create or replace function public.my_team() returns text
  language sql stable security definer set search_path = public as $$
  select team from public.league_members where email = lower(auth.jwt() ->> 'email')
$$;
create or replace function public.is_commissioner() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select is_commissioner from public.league_members
                   where email = lower(auth.jwt() ->> 'email')), false)
$$;
grant execute on function public.my_team(), public.is_commissioner() to authenticated;

-- 2. Deadlines: one row per waiver run ("post week N") ---------------------
create table if not exists public.waiver_windows (
  week_number  int primary key check (week_number between 1 and 16),
  deadline     timestamptz not null,
  note         text
);
alter table public.waiver_windows enable row level security;
drop policy if exists "waiver_windows read"  on public.waiver_windows;
drop policy if exists "waiver_windows write" on public.waiver_windows;
create policy "waiver_windows read"  on public.waiver_windows for select to anon, authenticated using (true);
create policy "waiver_windows write" on public.waiver_windows for all to authenticated
  using (public.is_commissioner()) with check (public.is_commissioner());
grant select on public.waiver_windows to anon, authenticated;
grant insert, update, delete on public.waiver_windows to authenticated;

-- Default deadlines: Thursday noon ET of the following NFL week. The commissioner
-- can move one earlier on the page (e.g. Thanksgiving, Rule III-A).
insert into public.waiver_windows (week_number, deadline) values
  (12, '2026-12-03 12:00 America/New_York'),
  (13, '2026-12-10 12:00 America/New_York'),
  (14, '2026-12-17 12:00 America/New_York'),
  (15, '2026-12-24 12:00 America/New_York'),
  (16, '2026-12-31 12:00 America/New_York')
on conflict (week_number) do nothing;

create or replace function public.waiver_closed(wk int) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select now() >= deadline from public.waiver_windows where week_number = wk), false)
$$;
grant execute on function public.waiver_closed(int) to anon, authenticated;

-- 3. Ranked claims ----------------------------------------------------------
-- One row per entry in a team's ranked list. drop_name null = claim without a
-- drop (only allowed when the roster has fewer than 24; the page checks).
create table if not exists public.waiver_claims (
  week_number  int  not null references public.waiver_windows(week_number) on delete cascade,
  team         text not null check (team in ('PD','OS','FAB','WILD','SV','RHR','COM','NUTS')),
  rank         int  not null check (rank between 1 and 30),
  claim_name   text not null check (length(claim_name) between 1 and 80),
  claim_pos    text not null check (claim_pos in ('K','QB','RB','WR','TE/WR','DL/LB','DB')),
  claim_nfl    text not null check (length(claim_nfl) between 2 and 4),
  claim_espn_id text,
  drop_name    text check (drop_name is null or length(drop_name) between 1 and 80),
  submitted_by text not null default lower(auth.jwt() ->> 'email'),
  submitted_at timestamptz not null default now(),
  primary key (week_number, team, rank)
);
alter table public.waiver_claims enable row level security;
drop policy if exists "waiver_claims read" on public.waiver_claims;
create policy "waiver_claims read" on public.waiver_claims for select to anon, authenticated
  using (public.waiver_closed(week_number) or team = public.my_team());
grant select on public.waiver_claims to anon, authenticated;
-- No insert/update/delete policies: all writes go through save_waiver_claims().

-- Replace a team's whole ranked list in one go (an empty list withdraws it).
create or replace function public.save_waiver_claims(wk int, claims jsonb) returns int
  language plpgsql security definer set search_path = public as $$
declare
  t text := public.my_team();
  n int;
begin
  if t is null then raise exception 'You are not set up as a GM for any team.'; end if;
  if not exists (select 1 from public.waiver_windows where week_number = wk) then
    raise exception 'There is no waiver run for week %.', wk; end if;
  if public.waiver_closed(wk) then raise exception 'The deadline for this waiver run has passed.'; end if;
  if jsonb_typeof(claims) <> 'array' then raise exception 'claims must be a list'; end if;
  n := jsonb_array_length(claims);
  if n > 30 then raise exception 'At most 30 claims.'; end if;
  if (select count(distinct lower(c ->> 'claim_name') || '|' || upper(c ->> 'claim_nfl'))
        from jsonb_array_elements(claims) c) <> n then
    raise exception 'The same player is listed twice.'; end if;

  delete from public.waiver_claims where week_number = wk and team = t;
  insert into public.waiver_claims (week_number, team, rank, claim_name, claim_pos, claim_nfl, claim_espn_id, drop_name)
  select wk, t, ord::int, c ->> 'claim_name', c ->> 'claim_pos', upper(c ->> 'claim_nfl'),
         nullif(c ->> 'claim_espn_id', ''), nullif(c ->> 'drop_name', '')
  from jsonb_array_elements(claims) with ordinality as x(c, ord);
  return n;
end $$;
revoke all on function public.save_waiver_claims(int, jsonb) from public, anon;
grant execute on function public.save_waiver_claims(int, jsonb) to authenticated;

-- 4. Coin tosses (Rule III-C-4) --------------------------------------------
-- For teams still tied after every other tiebreaker: rank 1 picks first.
create table if not exists public.waiver_coin_tosses (
  week_number  int  not null references public.waiver_windows(week_number) on delete cascade,
  team         text not null check (team in ('PD','OS','FAB','WILD','SV','RHR','COM','NUTS')),
  pick_rank    int  not null check (pick_rank between 1 and 8),
  entered_at   timestamptz not null default now(),
  primary key (week_number, team)
);
alter table public.waiver_coin_tosses enable row level security;
drop policy if exists "waiver_coin_tosses read"  on public.waiver_coin_tosses;
drop policy if exists "waiver_coin_tosses write" on public.waiver_coin_tosses;
create policy "waiver_coin_tosses read"  on public.waiver_coin_tosses for select to anon, authenticated using (true);
create policy "waiver_coin_tosses write" on public.waiver_coin_tosses for all to authenticated
  using (public.is_commissioner()) with check (public.is_commissioner());
grant select on public.waiver_coin_tosses to anon, authenticated;
grant insert, update, delete on public.waiver_coin_tosses to authenticated;

-- 5. Sanity check: should return the five default deadlines.
select week_number, deadline at time zone 'America/New_York' as deadline_et from public.waiver_windows order by 1;

-- 6. GMs: one row per login email (lower case). Fill in the real addresses,
--    uncomment, and run. Mark the commissioner with true.
-- insert into public.league_members (email, team, is_commissioner) values
--   ('someone@example.com', 'PD',   false),
--   ('someone@example.com', 'OS',   false),
--   ('someone@example.com', 'FAB',  false),
--   ('someone@example.com', 'WILD', false),
--   ('someone@example.com', 'SV',   false),
--   ('fitz1j@gmail.com',    'RHR',  false),
--   ('someone@example.com', 'COM',  false),
--   ('someone@example.com', 'NUTS', false)
-- on conflict (email) do update set team = excluded.team, is_commissioner = excluded.is_commissioner;
