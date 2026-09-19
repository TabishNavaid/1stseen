-- Tighten authenticated writes and remove direct execution of trigger helpers.

revoke execute on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

revoke update on public.profiles from authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;

drop policy if exists "users manage readiness" on public.readiness_milestones;
create policy "users read their readiness milestones"
on public.readiness_milestones for select to authenticated
using (auth.uid() = user_id);
create policy "users complete their readiness milestones"
on public.readiness_milestones for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke insert, update, delete on public.readiness_milestones from authenticated;
grant update (completed_at) on public.readiness_milestones to authenticated;

comment on policy "users complete their readiness milestones" on public.readiness_milestones is
  'Authenticated users may update only completed_at through column privileges. Planner-owned dates and forecast links remain service-write-only.';
