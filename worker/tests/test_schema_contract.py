import re
import unittest
from pathlib import Path

from firstseen.repository import OUT_OF_SCOPE_TEXT_KEPT


class SchemaContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140001_initial_schema.sql"
        ).read_text()
        cls.adapter_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140002_source_adapters.sql"
        ).read_text()
        cls.discovery_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140003_company_discovery.sql"
        ).read_text()
        cls.history_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140004_wayback_history.sql"
        ).read_text()
        cls.role_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140005_role_resolution.sql"
        ).read_text()
        cls.model_router_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140006_model_router.sql"
        ).read_text()
        cls.inference_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140007_inference_efficiency.sql"
        ).read_text()
        cls.forecast_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140008_hierarchical_forecasting.sql"
        ).read_text()
        cls.backtest_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140009_backtesting.sql"
        ).read_text()
        cls.signal_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140010_recruiting_signals.sql"
        ).read_text()
        cls.reddit_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140011_reddit_intelligence.sql"
        ).read_text()
        cls.agent_schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140012_recruiting_agent.sql"
        ).read_text()
        cls.agent_question_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140013_agent_question_indexes.sql"
        ).read_text()
        cls.readiness_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140014_application_readiness_planner.sql"
        ).read_text()
        cls.personalization_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140015_watchlists_and_personalization.sql"
        ).read_text()
        cls.google_calendar_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140016_google_calendar_integration.sql"
        ).read_text()
        cls.email_digest_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140017_email_intelligence_digests.sql"
        ).read_text()
        cls.collection_checkpoint_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140018_collection_checkpoints.sql"
        ).read_text()
        cls.security_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140019_security_hardening.sql"
        ).read_text()
        cls.forecasting_audit_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140020_forecasting_audit.sql"
        ).read_text()
        cls.signal_hardening_schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140021_signal_type_and_service_only_hardening.sql"
        ).read_text()
        cls.seed = (Path(__file__).resolve().parents[2] / "supabase/seed.sql").read_text()
        cls.migration_sql = "\n".join(
            path.read_text()
            for path in sorted(
                (Path(__file__).resolve().parents[2] / "supabase/migrations").glob("*.sql")
            )
        )

    def test_seed_conflict_targets_have_a_matching_constraint(self):
        """A dropped uniqueness must not leave an uninferrable ON CONFLICT target."""
        self.assertIn(
            "drop constraint if exists forecast_evidence_forecast_id_observation_id_contribution_key",
            self.signal_schema,
        )
        # The constraint was removed on purpose and must not be reinstated.
        self.assertNotIn("on conflict (forecast_id, observation_id, contribution)", self.seed)
        self.assertNotIn("unique (forecast_id, observation_id, contribution)", self.migration_sql[
            self.migration_sql.index("drop constraint if exists forecast_evidence"):
        ])
        # Every seeded insert stays idempotent through an explicit conflict target.
        for statement in self.seed.split("insert into ")[1:]:
            self.assertIn("on conflict", statement)
            self.assertNotIn("on conflict do nothing", statement)

    def test_seeded_forecast_evidence_rows_carry_explicit_primary_keys(self):
        evidence = self.seed.split("insert into public.forecast_evidence")[1]
        self.assertTrue(evidence.lstrip().startswith("(id,"))
        self.assertIn("on conflict (id) do nothing;", evidence)

    def test_supported_signal_types_match_the_runtime_model(self):
        from firstseen.signals import SIGNAL_STRENGTH

        constraint = self.signal_hardening_schema.split("signals_kind_normalized_check check (kind in (")[1]
        permitted = {
            value.strip().strip("',)") for value in constraint.split(")")[0].split(",") if value.strip()
        }
        self.assertEqual(permitted, set(SIGNAL_STRENGTH))
        self.assertNotIn("program_page_change'", self.seed)
        self.assertIn(
            "update public.signals\nset kind = 'internship_program_page_changed'",
            self.signal_hardening_schema,
        )

    def test_automation_tables_revoke_browser_privileges(self):
        for table in (
            "backtest_runs",
            "backtest_cases",
            "signal_source_states",
            "forecast_changes",
        ):
            self.assertIn(
                f"revoke all on public.{table} from anon, authenticated;",
                self.signal_hardening_schema,
            )

    def test_persisted_text_is_bounded_by_bytes_not_characters(self):
        """Schema columns bound evidence with octet_length, records bound characters.

        Observed against live non-English boards: a posting that validates in Python
        was rejected by Postgres because multi-byte text exceeds the byte budget.
        """
        from firstseen.repository import bounded_utf8

        text = "Praktikant für Softwareentwicklung – München (m/w/d) « » " * 1100
        self.assertLessEqual(len(text), 65_536, "precondition: passes character validation")
        self.assertGreater(len(text.encode()), 65_536, "precondition: exceeds the byte constraint")

        bounded = bounded_utf8(text, 65_536)
        self.assertLessEqual(len(bounded.encode()), 65_536)
        self.assertTrue(bounded)
        # Truncation never splits a character.
        self.assertEqual(bounded, bounded.encode().decode())
        # ASCII text within budget is returned untouched.
        self.assertEqual(bounded_utf8("plain text", 65_536), "plain text")

    def test_seeded_forecast_declares_the_current_model_version(self):
        from firstseen.forecasting import MODEL_VERSION

        self.assertIn(f"'{MODEL_VERSION}'", self.seed)
        self.assertNotIn("hierarchical-circular-shrinkage-v1", self.seed)

    def test_core_entities_exist(self):
        for table in (
            "profiles",
            "companies",
            "canonical_roles",
            "sources",
            "raw_job_observations",
            "historical_opening_events",
            "signals",
            "forecasts",
            "forecast_evidence",
            "watchlists",
            "readiness_milestones",
            "agent_runs",
            "agent_tool_calls",
            "model_usage",
        ):
            self.assertIn(f"create table public.{table}", self.schema)

    def test_forecast_inputs_have_provenance_links(self):
        self.assertIn("observation_id uuid not null references public.raw_job_observations", self.schema)
        self.assertIn("create view public.forecast_provenance", self.schema)
        self.assertIn("check (historical_opening_event_id is not null or signal_id is not null)", self.schema)

    def test_user_owned_tables_enable_rls(self):
        self.assertIn("alter table public.watchlists enable row level security", self.schema)
        self.assertIn("alter table public.readiness_milestones enable row level security", self.schema)

    def test_google_calendar_credentials_and_idempotent_mappings_are_protected(self):
        schema = self.google_calendar_schema
        self.assertIn("create table public.google_calendar_connections", schema)
        self.assertIn("access_token_ciphertext text not null", schema)
        self.assertIn("refresh_token_ciphertext text not null", schema)
        self.assertIn("revoke all on public.google_calendar_connections from anon, authenticated", schema)
        self.assertIn("alter table public.google_calendar_connections enable row level security", schema)
        self.assertIn("create table public.calendar_event_syncs", schema)
        self.assertIn("google_event_id text not null", schema)
        self.assertIn("unique (user_id, provider, source_kind, source_key)", schema)
        self.assertIn("revoke insert, update, delete on public.calendar_event_syncs from authenticated", schema)

    def test_email_digest_delivery_is_private_provenance_linked_and_idempotent(self):
        schema = self.email_digest_schema
        self.assertIn("create table public.gmail_connections", schema)
        self.assertIn("revoke all on public.gmail_connections from anon, authenticated", schema)
        self.assertIn("create table public.email_digest_deliveries", schema)
        self.assertIn("unique (user_id, channel, input_fingerprint)", schema)
        self.assertIn("external_message_id text", schema)
        self.assertIn("create table public.email_digest_items", schema)
        for field in (
            "forecast_id uuid references public.forecasts",
            "forecast_change_id uuid references public.forecast_changes",
            "historical_opening_event_id uuid references public.historical_opening_events",
            "readiness_milestone_id uuid references public.readiness_milestones",
        ):
            self.assertIn(field, schema)
        self.assertIn("revoke insert, update, delete on public.email_digest_deliveries", schema)

    def test_collection_checkpoints_are_service_only_and_run_linked(self):
        schema = self.collection_checkpoint_schema
        self.assertIn("create table public.collection_checkpoints", schema)
        self.assertIn("pipeline text primary key", schema)
        self.assertIn("last_run_id uuid references public.agent_runs", schema)
        self.assertIn("alter table public.collection_checkpoints enable row level security", schema)
        self.assertIn("revoke all on public.collection_checkpoints from anon, authenticated", schema)

    def test_security_hardening_limits_profile_and_readiness_writes(self):
        schema = self.security_schema
        self.assertIn("revoke execute on function public.create_profile_for_new_user()", schema)
        self.assertIn("grant update (display_name, timezone) on public.profiles", schema)
        self.assertIn("revoke insert, update, delete on public.readiness_milestones", schema)
        self.assertIn("grant update (completed_at) on public.readiness_milestones", schema)
        self.assertNotIn("for all to authenticated", schema)

    def test_normalized_observation_fields_and_bounded_evidence_exist(self):
        for field in (
            "identity_key",
            "source_url",
            "apply_url",
            "raw_title",
            "company_name",
            "location",
            "employment_type",
            "published_at",
            "first_seen_at",
            "last_seen_at",
            "source_type",
            "source_reliability",
            "evidence_excerpt",
        ):
            self.assertIn(f"add column {field}", self.adapter_schema)
        self.assertIn("octet_length(raw_text) <= 65536", self.adapter_schema)
        self.assertIn("create table public.source_fetches", self.adapter_schema)

    def test_discovery_identity_and_source_provenance_are_persisted(self):
        for field in ("recruiting_url", "ats_provider", "ats_tenant"):
            self.assertIn(f"add column {field}", self.discovery_schema)
        self.assertIn("create table public.source_discovery_evidence", self.discovery_schema)
        self.assertIn("source_id uuid not null references public.sources", self.discovery_schema)
        self.assertIn("evidence_quote text not null", self.discovery_schema)
        self.assertIn("octet_length(evidence_quote) <= 8192", self.discovery_schema)
        self.assertIn("evidence_fingerprint text generated always as", self.discovery_schema)

    def test_wayback_captures_and_opening_uncertainty_are_persisted(self):
        self.assertIn("create table public.archive_captures", self.history_schema)
        self.assertIn(
            "observation_id uuid not null unique references public.raw_job_observations", self.history_schema
        )
        for field in (
            "opening_window_start",
            "opening_window_end",
            "date_precision",
            "uncertainty_days",
            "uncertainty_reason",
            "resolution_method",
            "provenance",
        ):
            self.assertIn(f"add column {field}", self.history_schema)
        self.assertIn(
            "content_existed_by_capture_time",
            (Path(__file__).resolve().parents[1] / "src/firstseen/adapters/wayback.py").read_text(),
        )

    def test_role_aliases_and_match_decisions_are_persisted(self):
        self.assertIn("create table public.role_aliases", self.role_schema)
        self.assertIn("create table public.observation_role_matches", self.role_schema)
        self.assertIn("observation_id uuid primary key", self.role_schema)
        for field in (
            "company_normalized",
            "normalized_title",
            "role_family",
            "level",
            "recruiting_season",
            "specialization",
            "feature_profile",
            "resolver_version",
        ):
            self.assertIn(f"add column {field}", self.role_schema)

    def test_model_attempts_capture_capability_failures_and_fallbacks(self):
        self.assertIn("alter column agent_run_id drop not null", self.model_router_schema)
        for field in ("capability", "success", "failure_kind", "fallback_reason"):
            self.assertIn(f"add column {field}", self.model_router_schema)
        for failure in (
            "rate_limit",
            "quota_exhausted",
            "temporary_provider",
            "timeout",
            "invalid_structured_output",
            "permanent_provider",
        ):
            self.assertIn(failure, self.model_router_schema)

    def test_inference_decisions_and_admin_metrics_are_persisted(self):
        self.assertIn("create table public.inference_decisions", self.inference_schema)
        self.assertIn("create view public.inference_run_metrics", self.inference_schema)
        self.assertIn("add column inference_decision", self.inference_schema)
        for metric in (
            "pages_processed",
            "pages_changed",
            "deterministically_parsed",
            "llm_escalations",
            "llm_escalation_percentage",
            "successful_model_extractions",
            "fallback_frequency",
        ):
            self.assertIn(metric, self.inference_schema)

    def test_sparse_hierarchical_forecasts_retain_full_model_outputs(self):
        self.assertIn("history_count >= 0", self.forecast_schema)
        for field in (
            "calibrated_probability",
            "feature_contributions",
            "prior_effective_sample_size",
            "prediction_interval_coverage",
            "forecasted_at",
        ):
            self.assertIn(f"add column {field}", self.forecast_schema)
        for contribution in (
            "role_history",
            "company_prior",
            "role_family_prior",
            "signal",
            "company_scale",
        ):
            self.assertIn(contribution, self.forecast_schema)
        methodology = (Path(__file__).resolve().parents[2] / "docs/forecasting-methodology.md").read_text()
        self.assertIn("Hierarchical shrinkage for sparse roles", methodology)
        self.assertIn("Circular date representation", methodology)

    def test_backtests_store_versions_metrics_and_leakage_audit(self):
        self.assertIn("create table public.backtest_runs", self.backtest_schema)
        self.assertIn("create table public.backtest_cases", self.backtest_schema)
        for field in (
            "output_schema_version",
            "model_versions",
            "dataset_fingerprint",
            "aggregate_metrics",
            "calibration_metrics",
            "forecast_cutoff",
            "actual_opened_on",
            "input_event_ids",
            "input_signal_ids",
            "latest_input_available_on",
        ):
            self.assertIn(field, self.backtest_schema)
        self.assertIn("not target_event_id = any(input_event_ids)", self.backtest_schema)
        self.assertIn("latest_input_available_on <= forecast_cutoff", self.backtest_schema)
        self.assertNotIn("insert into public.backtest_runs", self.backtest_schema)
        for field in ("actual_interval_start", "actual_interval_end", "target_date_precision"):
            self.assertIn(field, self.forecasting_audit_schema)
        self.assertIn(
            "observed-by targets are not quantitatively scored",
            self.forecasting_audit_schema.casefold(),
        )

    def test_normalized_signals_and_forecast_version_lineage_are_persisted(self):
        self.assertIn("alter column canonical_role_id drop not null", self.signal_schema)
        for field in (
            "company_id",
            "source_id",
            "source_url",
            "claimed_event_at",
            "extraction_method",
            "identity_key",
            "content_hash",
        ):
            self.assertIn(f"add column {field}", self.signal_schema)
        for signal_type in (
            "career_page_changed",
            "internship_program_page_changed",
            "new_relevant_sitemap_url",
            "company_recruiting_blog_post",
            "university_recruiting_page_update",
            "new_ats_role_family_appearing",
            "community_recruiting_discussion",
        ):
            self.assertIn(signal_type, self.signal_schema)
        self.assertIn("create table public.signal_source_states", self.signal_schema)
        self.assertIn("create table public.forecast_changes", self.signal_schema)
        self.assertIn("add column supersedes_forecast_id", self.signal_schema)
        self.assertIn("add column trigger_signal_ids", self.signal_schema)

    def test_reddit_evidence_is_supporting_only_and_keeps_platform_time_separate(self):
        self.assertIn("'reddit'", self.reddit_schema)
        self.assertIn("add column source_published_at", self.reddit_schema)
        self.assertIn("distinct from 1stSeen observed_at", self.reddit_schema)
        self.assertIn("cannot independently confirm an opening event", self.reddit_schema)

    def test_agent_state_is_observable_audited_and_excludes_private_reasoning(self):
        self.assertIn("agent_runs_no_private_reasoning", self.agent_schema)
        self.assertIn("Never private chain-of-thought", self.agent_schema)
        self.assertIn("redacted inputs", self.agent_schema)

    def test_useful_agent_questions_have_indexed_evidence_paths(self):
        for index in (
            "forecasts_current_portfolio_idx",
            "forecast_changes_recent_idx",
            "readiness_user_due_open_idx",
            "watchlists_role_user_idx",
        ):
            self.assertIn(index, self.agent_question_schema)
        self.assertIn("without network collection", self.agent_question_schema)

    def test_readiness_plans_are_versioned_explainable_and_user_scoped(self):
        for field in (
            "ideal_due_on",
            "lead_days",
            "policy_version",
            "rationale",
            "adjustments",
            "window_start",
            "window_end",
        ):
            self.assertIn(field, self.readiness_schema)
        for kind in (
            "networking",
            "referral_contacts",
            "resume_ready",
            "portfolio_ready",
            "high_alert",
        ):
            self.assertIn(kind, self.readiness_schema)
        self.assertIn("user_id, forecast_id, kind, policy_version", self.readiness_schema)

    def test_watchlist_and_preference_rls_has_complete_owner_boundaries(self):
        for table in ("watchlist_items", "recruiting_preferences", "priority_companies"):
            self.assertIn(
                f"alter table public.{table} enable row level security", self.personalization_schema
            )
            self.assertIn(f"revoke all on public.{table}", self.personalization_schema)
        for action in ("select", "insert", "update", "delete"):
            expected = 4 if action == "select" else 3
            self.assertEqual(self.personalization_schema.count(f"for {action} to authenticated"), expected)
        self.assertGreaterEqual(self.personalization_schema.count("auth.uid() = user_id"), 15)
        self.assertNotIn("using (true)", self.personalization_schema)

    def test_follow_scopes_and_preferences_are_normalized(self):
        for target in ("company", "canonical_role", "role_family", "track"):
            self.assertIn(f"'{target}'", self.personalization_schema)
        for preference in (
            "target_role_families",
            "graduation_year",
            "target_recruiting_season",
            "preferred_locations",
            "company_size_preferences",
            "priority_companies",
        ):
            self.assertIn(preference, self.personalization_schema)
        self.assertIn("Preferences rank this followed set", self.personalization_schema)


    def test_observation_role_evidence_is_many_to_many(self):
        """One archived page is evidence for many roles; the pair is the natural key."""
        schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140022_observation_role_evidence.sql"
        ).read_text()
        self.assertIn("drop constraint if exists observation_role_matches_pkey", schema)
        self.assertIn("primary key (observation_id, canonical_role_id)", schema)
        # At most one row per observation may claim the primary posting identity.
        self.assertIn("observation_role_matches_primary_key_idx", schema)
        self.assertIn("where is_primary", schema)
        self.assertIn("evidence_kind in ('observation_resolution', 'archive_page_attribution')", schema)
        # Writes stay service-role only.
        self.assertIn(
            "revoke insert, update, delete on public.observation_role_matches from anon, authenticated",
            schema,
        )

    def test_cycle_identity_is_versioned_and_documented(self):
        from firstseen.cycles import ANNUAL_CYCLE_MIN_GAP_DAYS, CYCLE_IDENTITY_VERSION

        self.assertTrue(CYCLE_IDENTITY_VERSION)
        self.assertGreater(ANNUAL_CYCLE_MIN_GAP_DAYS, 45)
        methodology = (
            Path(__file__).resolve().parents[2] / "docs/forecasting-methodology.md"
        ).read_text()
        self.assertIn(CYCLE_IDENTITY_VERSION, methodology)
        self.assertIn("sample_size", methodology)

    def test_a_role_re_key_is_audited_and_never_deletes_a_role(self):
        """Migration 202608140034: splitting a merged role keeps everything it was evidence for."""
        schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140034_role_identity_re_resolution.sql"
        ).read_text()
        # Every re-key is auditable, and the audit is automation-only like every worker-written table.
        self.assertIn("create table public.role_identity_migrations", schema)
        self.assertIn("alter table public.role_identity_migrations enable row level security", schema)
        self.assertIn("revoke all on public.role_identity_migrations from anon, authenticated", schema)
        self.assertNotIn("create policy", schema)
        # A retired role is deactivated and pointed at its successor, never dropped.
        self.assertIn("superseded_by uuid references public.canonical_roles(id)", schema)
        self.assertIn("check (superseded_at is null or active = false)", schema)
        self.assertNotIn("delete from public.canonical_roles", schema)
        self.assertNotIn("drop table", schema)
        # Forecasts and backtest cases are never moved: a stored prediction records what was
        # predicted from the evidence as it stood.
        for table in ("forecasts", "backtest_cases", "email_digest_items", "forecast_evidence"):
            self.assertNotIn(f"update public.{table}", schema)
        # The split refuses evidence that has moved since it was planned.
        self.assertIn("still belong to role", schema)
        self.assertIn("security invoker", schema)
        self.assertIn(") from public, anon, authenticated;", schema)
        self.assertIn(") to service_role;", schema)

    def test_a_takedown_is_audited_service_only_and_deletes_nothing(self):
        """Migration 202608140039: stopping, resuming, and withdrawing collection (docs/takedown.md)."""
        schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140039_collection_takedowns.sql"
        ).read_text()
        self.assertIn("create table public.collection_takedowns", schema)
        self.assertIn("alter table public.collection_takedowns enable row level security", schema)
        self.assertIn("revoke all on public.collection_takedowns from anon, authenticated", schema)
        self.assertNotIn("create policy", schema)
        # Who, when, why, and exactly what changed.
        for column in ("recorded_at", "reason", "requested_by", "source_ids", "role_ids"):
            self.assertIn(column, schema)
        self.assertIn("check (action in ('disable', 'enable', 'withdraw', 'erase'))", schema)
        # The function never erases; only the documented manual step writes an `erase` row.
        self.assertIn("p_action not in ('disable', 'enable', 'withdraw')", schema)
        # The record of a request outlives an erasure of what was collected.
        self.assertIn("references public.companies(id) on delete restrict", schema)
        # A withdrawal flips flags; it never deletes a role, an observation, or a forecast.
        self.assertIn("set active = false", schema)
        self.assertNotIn("delete from", schema)
        self.assertNotIn("drop table", schema)
        # Lifting a hold never revives a role a re-resolution superseded.
        self.assertIn("r.superseded_at is null", schema)
        self.assertIn("security invoker", schema)
        self.assertIn(") from public, anon, authenticated;", schema)
        self.assertIn(") to service_role;", schema)

    def test_trimming_out_of_scope_text_spares_in_scope_ambiguous_and_unresolved_rows(self):
        """Migration 202608140047: what the trim may shorten, and what it may never touch.

        Half the corpus is the text of postings nobody can apply to. Shortening it cannot be undone from the database,
        so the rows it spares are part of the contract: an ambiguous role is waiting on a person's judgement and that
        person needs the text, and an unresolved posting's text is what resolution reads.
        """
        # 048 replaces 047's one-statement form with a chunked one; both are read, because the rules the trim must
        # keep are stated in 047 and carried by 048.
        schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140047_trim_out_of_scope_text.sql"
        ).read_text() + (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140048_trim_in_chunks.sql"
        ).read_text()
        # Only out-of-scope roles' own text.
        self.assertIn("where scope_status = 'out_of_scope'", schema)
        self.assertIn("and r.scope_status = 'out_of_scope'", schema)
        # A posting is spared unless it is resolved and no role it matches is in scope or ambiguous.
        self.assertIn("exists (select 1 from public.observation_role_matches m where m.observation_id = o.id)", schema)
        self.assertIn("and r.scope_status in ('in_scope', 'ambiguous')", schema)
        self.assertIn("not exists (", schema)
        # It shortens; it never deletes a row or empties a column.
        self.assertIn("left(", schema)
        self.assertNotIn("delete from", schema)
        for column in ("evidence_excerpt", "evidence_quote", "description_prototype"):
            self.assertNotIn(f"{column} = null", schema)
            self.assertNotIn(f"{column} = ''", schema)
        # It reports what it changed, and the sizes come from the catalogue rather than from scanning the text:
        # summing it does not finish in eight seconds, and the measurement killed the trim twice before shortening
        # anything (migration 050).
        catalogue = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140050_corpus_sizes_from_the_catalogue.sql"
        ).read_text()
        self.assertIn("drop function if exists public.out_of_scope_text_bytes();", catalogue)
        self.assertIn("pg_total_relation_size(nullif(c.reltoastrelid, 0))", catalogue)
        # The body, not the comment that explains why the sums are gone.
        body = catalogue[catalogue.index("create or replace function public.corpus_text_sizes") :]
        self.assertNotIn("sum(length(", body)
        self.assertIn(") to service_role;", catalogue)
        # A call is bounded, because PostgREST connects under an eight-second statement timeout: one statement over the
        # whole corpus failed with 57014 on the first scheduled run that tried it.
        self.assertIn("p_limit must be between 1 and 5000", schema)
        self.assertIn("limit p_limit", schema)
        for field in ("remaining_observations", "remaining_roles", "remaining_events"):
            self.assertIn(field, schema)
        self.assertIn("drop function if exists public.trim_out_of_scope_text(integer);", schema)
        # Service-only, like every function the worker calls, and bounded.
        self.assertIn("p_keep must be between 1 and 8192", schema)
        self.assertIn(") from public, anon, authenticated;", schema)
        self.assertIn(") to service_role;", schema)

    def test_untrimmed_text_indexes_match_what_the_trim_keeps(self):
        """Migration 202608140051: the trim finds its rows through partial indexes, which serve it only at p_keep = 300.

        Selecting and counting the rows still to shorten with `length(<column>) > p_keep` reads the text of every row it
        passes, and on hosted the first call timed out with nothing shortened. A partial index is used only by a query
        whose predicate matches its own, so the kept length in the indexes, the function's default, and the worker's
        constant must be one number: change one, and the trim quietly goes back to scanning the text.
        """
        root = Path(__file__).resolve().parents[2] / "supabase/migrations"
        indexes = (root / "202608140051_untrimmed_text_indexes.sql").read_text()
        chunked = (root / "202608140048_trim_in_chunks.sql").read_text()
        # The statements, not the header that explains them.
        body = "\n".join(line for line in indexes.splitlines() if not line.startswith("--"))
        kept = {int(value) for value in re.findall(r"length\((?:evidence_excerpt|description_prototype|evidence_quote)\) > (\d+)", body)}
        self.assertEqual(kept, {OUT_OF_SCOPE_TEXT_KEPT})
        self.assertIn(f"p_keep integer default {OUT_OF_SCOPE_TEXT_KEPT}", chunked)
        # One index per column the trim shortens, each on the same condition the function selects by.
        for predicate in (
            "on public.raw_job_observations (id)\n  where length(evidence_excerpt) >",
            "on public.canonical_roles (id)\n  where scope_status = 'out_of_scope' and length(description_prototype) >",
            "on public.historical_opening_events (canonical_role_id, id)\n  where length(evidence_quote) >",
        ):
            self.assertIn(predicate, body)
        for condition in (
            "length(o.evidence_excerpt) > p_keep",
            "scope_status = 'out_of_scope'\n       and length(description_prototype) > p_keep",
            "length(e.evidence_quote) > p_keep",
        ):
            self.assertIn(condition, chunked)
        # Indexes only: the migration changes no rule of the trim, and drops nothing.
        self.assertNotIn("create or replace function", body)
        self.assertNotIn("drop ", body)
        self.assertNotIn("concurrently", body)

    def test_scope_reviews_are_service_only_and_written_with_the_role_outcome(self):
        schema = (
            Path(__file__).resolve().parents[2] / "supabase/migrations/202608140033_role_scope_reviews.sql"
        ).read_text()
        self.assertIn("alter table public.role_scope_reviews enable row level security", schema)
        self.assertIn("revoke all on public.role_scope_reviews from anon, authenticated", schema)
        self.assertNotIn("create policy", schema)
        self.assertIn("check (scope_method in ('deterministic', 'model_assisted', 'human_review'))", schema)
        # The review row and the role outcome land together, only on the role the reviewer was shown.
        self.assertIn("security invoker", schema)
        self.assertIn("scope_classified_at = p_listed_classified_at", schema)
        self.assertIn("(scope_status = 'ambiguous' or scope_method = 'human_review')", schema)
        self.assertIn(") from public, anon, authenticated;", schema)
        self.assertIn(") to service_role;", schema)

    def test_signed_in_sessions_keep_only_the_writes_the_routes_perform(self):
        """Migration 202608140038: authenticated writes only its own watchlist, preferences, and priorities."""
        schema = (
            Path(__file__).resolve().parents[2]
            / "supabase/migrations/202608140038_revoke_authenticated_writes.sql"
        ).read_text()
        self.assertIn(
            "revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated",
            schema,
        )
        # Column grants survive a table-level revoke; the migration revokes them by name.
        self.assertIn("aclexplode(a.attacl)", schema)
        self.assertIn("revoke update on all sequences in schema public from authenticated", schema)
        for grant in (
            "grant insert, delete on public.watchlist_items to authenticated",
            "grant update (alerts_enabled) on public.watchlist_items to authenticated",
            "grant insert, update on public.recruiting_preferences to authenticated",
            "grant insert, delete on public.priority_companies to authenticated",
        ):
            self.assertIn(grant, schema)
        # Nothing else is granted back, and nothing is granted TRUNCATE.
        self.assertEqual(schema.count("\ngrant "), 4)
        self.assertNotIn("grant truncate", schema)
        self.assertIn(
            "alter default privileges for role postgres in schema public\n"
            "  revoke insert, update, delete, truncate, references, trigger on tables from authenticated",
            schema,
        )
        self.assertIn(
            "alter default privileges for role postgres in schema public revoke update on sequences from authenticated",
            schema,
        )


if __name__ == "__main__":
    unittest.main()
