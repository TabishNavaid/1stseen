-- Discovery may record a careers page it reached by its conventional path (/careers, /jobs) when the
-- homepage HTML links none, as script-rendered navigation does. The evidence method says so rather than
-- claiming an HTML link that was never observed.
alter table public.source_discovery_evidence
  drop constraint source_discovery_evidence_method_check,
  add constraint source_discovery_evidence_method_check check (method in (
    'input_domain',
    'dns',
    'redirect',
    'structured_metadata',
    'html_link',
    'known_ats_pattern',
    'robots_sitemap',
    'sitemap_probe',
    'feed_link',
    'llm_identity',
    'conventional_path'
  ));
