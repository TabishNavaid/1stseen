-- User-owned follow scopes and explicit recruiting preferences.

create table public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (
    target_type in ('company', 'canonical_role', 'role_family', 'track')
  ),
  company_id uuid references public.companies(id) on delete cascade,
  canonical_role_id uuid references public.canonical_roles(id) on delete cascade,
  role_family text check (
    role_family is null or role_family ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ),
  track public.role_track,
  alerts_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_type = 'company' and company_id is not null and canonical_role_id is null and role_family is null and track is null)
    or (target_type = 'canonical_role' and company_id is null and canonical_role_id is not null and role_family is null and track is null)
    or (target_type = 'role_family' and company_id is null and canonical_role_id is null and role_family is not null and track is null)
    or (target_type = 'track' and company_id is null and canonical_role_id is null and role_family is null and track in ('internship', 'new_grad'))
  )
);

insert into public.watchlist_items (user_id, target_type, canonical_role_id, alerts_enabled, created_at, updated_at)
select user_id, 'canonical_role', canonical_role_id, alerts_enabled, created_at, updated_at
from public.watchlists
on conflict do nothing;

drop policy if exists "users manage watchlists" on public.watchlists;
create policy "users read migrated legacy watchlists"
on public.watchlists for select to authenticated
using (auth.uid() = user_id);
revoke insert, update, delete on public.watchlists from authenticated;
comment on table public.watchlists is
  'Legacy role-only follows retained for migration audit; new writes use watchlist_items.';

create unique index watchlist_items_company_key
  on public.watchlist_items (user_id, company_id) where target_type = 'company';
create unique index watchlist_items_role_key
  on public.watchlist_items (user_id, canonical_role_id) where target_type = 'canonical_role';
create unique index watchlist_items_family_key
  on public.watchlist_items (user_id, role_family) where target_type = 'role_family';
create unique index watchlist_items_track_key
  on public.watchlist_items (user_id, track) where target_type = 'track';

create table public.recruiting_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  target_role_families text[] not null default '{}',
  graduation_year integer check (graduation_year between 2000 and 2100),
  target_recruiting_season text check (
    target_recruiting_season is null
    or target_recruiting_season in ('spring', 'summer', 'fall', 'winter', 'year_round', 'unknown')
  ),
  preferred_locations text[] not null default '{}',
  company_size_preferences text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    company_size_preferences <@ array['startup', 'small', 'medium', 'large', 'enterprise', 'unknown']::text[]
  ),
  check (array_position(target_role_families, null) is null),
  check (array_position(preferred_locations, null) is null),
  check (array_position(company_size_preferences, null) is null),
  check (array_to_string(target_role_families, ',') ~ '^([a-z0-9]+(_[a-z0-9]+)*(,[a-z0-9]+(_[a-z0-9]+)*)*)?$')
);

create table public.priority_companies (
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  priority smallint not null default 3 check (priority between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

create trigger watchlist_items_set_updated_at
before update on public.watchlist_items
for each row execute function public.set_updated_at();

create trigger recruiting_preferences_set_updated_at
before update on public.recruiting_preferences
for each row execute function public.set_updated_at();

create trigger priority_companies_set_updated_at
before update on public.priority_companies
for each row execute function public.set_updated_at();

create index watchlist_items_user_type_idx
  on public.watchlist_items (user_id, target_type);
create index watchlist_items_company_idx
  on public.watchlist_items (company_id, user_id) where company_id is not null;
create index watchlist_items_role_idx
  on public.watchlist_items (canonical_role_id, user_id) where canonical_role_id is not null;
create index watchlist_items_family_idx
  on public.watchlist_items (role_family, user_id) where role_family is not null;
create index watchlist_items_track_idx
  on public.watchlist_items (track, user_id) where track is not null;
create index priority_companies_priority_idx
  on public.priority_companies (user_id, priority desc, company_id);

alter table public.watchlist_items enable row level security;
alter table public.recruiting_preferences enable row level security;
alter table public.priority_companies enable row level security;

create policy "users read their watchlist items"
on public.watchlist_items for select to authenticated
using (auth.uid() = user_id);
create policy "users insert their watchlist items"
on public.watchlist_items for insert to authenticated
with check (auth.uid() = user_id);
create policy "users update their watchlist items"
on public.watchlist_items for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users delete their watchlist items"
on public.watchlist_items for delete to authenticated
using (auth.uid() = user_id);

create policy "users read their recruiting preferences"
on public.recruiting_preferences for select to authenticated
using (auth.uid() = user_id);
create policy "users insert their recruiting preferences"
on public.recruiting_preferences for insert to authenticated
with check (auth.uid() = user_id);
create policy "users update their recruiting preferences"
on public.recruiting_preferences for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users delete their recruiting preferences"
on public.recruiting_preferences for delete to authenticated
using (auth.uid() = user_id);

create policy "users read their priority companies"
on public.priority_companies for select to authenticated
using (auth.uid() = user_id);
create policy "users insert their priority companies"
on public.priority_companies for insert to authenticated
with check (auth.uid() = user_id);
create policy "users update their priority companies"
on public.priority_companies for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users delete their priority companies"
on public.priority_companies for delete to authenticated
using (auth.uid() = user_id);

grant select, insert, update, delete on public.watchlist_items to authenticated;
grant select, insert, update, delete on public.recruiting_preferences to authenticated;
grant select, insert, update, delete on public.priority_companies to authenticated;
revoke all on public.watchlist_items from anon;
revoke all on public.recruiting_preferences from anon;
revoke all on public.priority_companies from anon;

comment on table public.watchlist_items is
  'Explicit user follows. Preferences rank this followed set but never introduce unrelated recommendations.';
comment on table public.recruiting_preferences is
  'User-owned deterministic timeline ranking inputs; not a learned recommendation profile.';
