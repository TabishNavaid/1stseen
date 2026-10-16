-- How many consecutive collection attempts the recruiting-path rules have refused a source.
--
-- The rules refuse 132 of 439 enabled sources, and the obvious response -- disable all 132 -- is the smaller prize
-- and the wrong shape. A refusal is a live decision re-evaluated every run; a disable is a stored one that sticks.
-- Converting 132 live decisions into stored ones freezes today's rules into the database, and when the rules widen
-- again, as they did between September's 112 and October's 132, the stored ones do not follow.
--
-- So a source is retired by the rules themselves, after they have refused it on several consecutive attempts rather
-- than once. The streak is counted here, from the diagnostic the skip records, with the same semantics as
-- `source_failure_streaks` (migration 056): newest first, `running` ignored, the run of refusals before the first
-- attempt that was not refused. The refusal leaves no `source_fetches` row -- it returns before `record_fetch` --
-- so this reads `agent_tool_calls`, which is where the diagnostic codes are.
--
-- `rule` is the newest attempt's named reason (`recruiting_paths.page_source_refusal`), so an audit row can say
-- which rule retired a source. Attempts recorded before the rules carried names report null, and the retirement
-- command names the rule live rather than trusting a null.

create or replace function public.source_refusal_streaks(p_days integer default 30)
returns table (
  source_id uuid,
  consecutive_refusals integer,
  rule text,
  last_attempt timestamptz
)
language sql
stable
set search_path = ''
as $$
  with attempts as (
    select c.input_redacted ->> 'source_id' as source_text,
           c.output_redacted -> 'diagnostic_codes' @> '["source_not_on_recruiting_path"]' as refused,
           c.output_redacted as output,
           c.started_at,
           row_number() over (
             partition by c.input_redacted ->> 'source_id' order by c.started_at desc, c.id desc
           ) as rn
      from public.agent_tool_calls c
     where c.started_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365))
       and c.tool_name like 'source_adapter.%'
       and c.status <> 'running'
       and c.input_redacted ? 'source_id'
  ),
  -- The streak ends at the first attempt that was not refused; with none, every attempt in the window was.
  boundary as (select source_text, min(rn) as first_allowed from attempts where not refused group by 1)
  select s.id,
         count(*) filter (where a.rn < coalesce(b.first_allowed, 2147483647))::int,
         max(a.output #>> '{diagnostics,0,details,rule}') filter (where a.rn = 1),
         max(a.started_at) filter (where a.rn = 1)
    from attempts a
    join public.sources s on s.id::text = a.source_text
    left join boundary b on b.source_text = a.source_text
   group by s.id
  having count(*) filter (where a.rn < coalesce(b.first_allowed, 2147483647)) > 0
   order by 2 desc, 1;
$$;

comment on function public.source_refusal_streaks(integer) is
  'Consecutive collection attempts the recruiting-path rules refused, per source, newest first, over a window '
  'clamped to 365 days. Feeds automatic retirement, so a source leaves the list because the rules kept refusing it '
  'rather than because someone ran a loop once.';

revoke all on function public.source_refusal_streaks(integer) from public, anon, authenticated;
grant execute on function public.source_refusal_streaks(integer) to service_role;
