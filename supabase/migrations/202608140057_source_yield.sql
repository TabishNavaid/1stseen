-- What each source has ever produced, so a registered source that yields nothing stops being invisible.
--
-- Point72 has five sources over its careers search and Veeva three, and between them they have returned zero jobs
-- since they were registered. Nothing in the system has ever mentioned it, because a source returning no jobs looks
-- exactly like a source whose company has no openings today. So "registered but useless" accumulates silently, and
-- the measured number is not eight: of 439 enabled sources, 82 have been fetched successfully three or more times
-- and produced **nothing at all** -- no job, no recruiting signal, no archive capture.
--
-- The split is the finding. Every ATS board is productive: greenhouse 40 of 40, ashby 7 of 7, lever 3 of 3, zero
-- waste. All of it is page scraping -- generic 64 of 179 fetched (36%) and sitemap 18 of 30 (60%) -- and 27 of the
-- 33 companies holding a dead source also have a working board, so for those the page source adds nothing that is
-- not already arriving. Worst: Point72 11 of 15, IMC 10 of 12, Veeva 4 of 8.
--
-- Zero jobs alone would be the wrong test and would have condemned sources that earn their place: a careers page
-- that lists no openings can still emit page-change signals, and a Wayback source produces captures rather than
-- jobs. All three are counted here, and a source is only dead when it has produced none of them.
--
-- `refused` is the other half of the same complaint. A page off a recruiting path is skipped before any request
-- (`page_source_allowed`), and then the source sits in the list looking live. It is read from the stored diagnostic
-- rather than by restating the path rules here, so the predicate stays in `recruiting_paths.py` and cannot drift --
-- and specifically from the source's most recent collection tool call, because the refusal returns before
-- `record_fetch` and therefore writes no `source_fetches` row at all. Most recent, not ever, so a source whose
-- address was fixed stops being reported as refused.

create or replace function public.source_yield()
returns table (
  source_id uuid,
  company_name text,
  adapter text,
  url text,
  enabled boolean,
  successful_fetches bigint,
  jobs bigint,
  signals bigint,
  archive_captures bigint,
  refused boolean,
  last_fetched_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select s.id,
         c.name,
         s.adapter,
         s.url,
         s.enabled,
         coalesce(f.successful, 0),
         coalesce(o.jobs, 0),
         coalesce(g.signals, 0),
         coalesce(a.captures, 0),
         coalesce(r.refused, false),
         s.last_fetched_at
    from public.sources s
    join public.companies c on c.id = s.company_id
    left join (
      select source_id, count(*) filter (where error is null or error ->> 'status' = 'complete') as successful
        from public.source_fetches group by source_id
    ) f on f.source_id = s.id
    left join lateral (
      -- The newest collection attempt for this source, and whether the path rules refused it.
      select t.output_redacted -> 'diagnostic_codes' @> '["source_not_on_recruiting_path"]' as refused
        from public.agent_tool_calls t
       where t.tool_name like 'source_adapter.%'
         and t.input_redacted ->> 'source_id' = s.id::text
       order by t.started_at desc, t.id desc
       limit 1
    ) r on true
    left join (
      select source_id, count(distinct identity_key) as jobs from public.raw_job_observations group by source_id
    ) o on o.source_id = s.id
    left join (select source_id, count(*) as signals from public.signals group by source_id) g on g.source_id = s.id
    left join (
      select source_id, count(*) as captures from public.archive_captures group by source_id
    ) a on a.source_id = s.id
   order by s.id;
$$;

comment on function public.source_yield() is
  'Per source, everything it has ever produced -- jobs, recruiting signals, archive captures -- beside its successful '
  'fetch count, and whether the recruiting-path rules are refusing it. One row per source, so the health report can '
  'name a source that is paid for on every run and returns nothing.';

revoke all on function public.source_yield() from public, anon, authenticated;
grant execute on function public.source_yield() to service_role;
