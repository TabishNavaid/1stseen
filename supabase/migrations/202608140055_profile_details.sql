-- Who the person is, beside what they are watching.
--
-- The settings page held an email address and a count. These four columns are what a person can say about
-- themselves: a drawn character to stand in for a photograph, where they study, and the two places early-career
-- hiring actually looks.
--
-- The two links are stored as handles, not URLs. A handle is checked against the shape that service issues and the
-- product builds the address from it, so nothing here can hold an arbitrary URL that a page would then render as a
-- link the user did not mean, and nothing has to be validated again at render time.
--
-- The avatar is checked for shape only. Which characters are offered is a product decision that changes with the
-- art (apps/web/lib/profile.ts); a name this deployment does not know draws no character rather than failing a read.
--
-- Graduation year is not here: it already exists, on recruiting_preferences, where the first run wrote it.
--
-- No grant accompanies these. `authenticated` has no write on profiles (202608140038) and does not get one: the
-- only writer is apps/web/app/api/profile/route.ts, which takes the owner from the Supabase session.

alter table public.profiles
  add column avatar text
    check (avatar is null or avatar ~ '^[a-z][a-z-]{0,30}$'),
  add column school text
    check (school is null or (btrim(school) <> '' and length(school) <= 120)),
  add column github_handle text
    check (github_handle is null or github_handle ~ '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$'),
  add column linkedin_handle text
    check (linkedin_handle is null or linkedin_handle ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]){2,99}$');

comment on column public.profiles.avatar is
  'A drawn character from the product''s own set, by name. Shape-checked only; the set lives in apps/web/lib/profile.ts.';
comment on column public.profiles.school is
  'What the person calls where they study. Free text, trimmed and bounded; never matched against a list.';
comment on column public.profiles.github_handle is
  'A GitHub account name, without the address. The page builds https://github.com/<handle> from it.';
comment on column public.profiles.linkedin_handle is
  'A LinkedIn public profile name, without the address. The page builds https://www.linkedin.com/in/<handle> from it.';
