-- DadsFFL — lineup picks for web/weekly.html (2026-10-05)
--
-- One row = one player checked for one team in one week. Unchecking deletes the
-- row. A team's weekly total on weekly.html is the sum of its checked players.
--
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.
--
-- SECURITY NOTE: the policies below let ANYONE with the page (the publishable
-- key is public) check or uncheck any team's players. That is the agreed
-- starting point; tighten later with Supabase Auth (teams.owner_user_id) and
-- per-player game-time locks.

create table if not exists public.lineup_picks (
  week_id    bigint      not null references public.weeks(id) on delete cascade,
  team       text        not null check (team in ('PD','OS','FAB','WILD','SV','RHR','COM','NUTS')),
  player     text        not null check (length(player) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (week_id, team, player)
);

alter table public.lineup_picks enable row level security;

drop policy if exists "lineup_picks read"   on public.lineup_picks;
drop policy if exists "lineup_picks check"  on public.lineup_picks;
drop policy if exists "lineup_picks uncheck" on public.lineup_picks;

create policy "lineup_picks read"    on public.lineup_picks for select to anon, authenticated using (true);
create policy "lineup_picks check"   on public.lineup_picks for insert to anon, authenticated with check (true);
create policy "lineup_picks uncheck" on public.lineup_picks for delete to anon, authenticated using (true);

grant select, insert, delete on public.lineup_picks to anon, authenticated;

-- Sanity check: should return 0 rows and no error.
select * from public.lineup_picks limit 1;
