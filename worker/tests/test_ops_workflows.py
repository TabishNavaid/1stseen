"""Operations wiring: every scheduled workflow reports to the owner, and the backup covers every table on purpose.

- A scheduled workflow that fails, times out, or is cancelled must reach the owner: each one ends with the ops-alert
  step (`.github/actions/ops-alert`), run `if: always()` with the job's status, and holds `issues: write`.
- The production health check watches every scheduled workflow's last success, so one that stops running is noticed.
- Every table a migration creates is either in the corpus backup (`CORPUS_TABLES` in scripts/backup-corpus.mjs) or named
  in `NOT_BACKED_UP` with a reason: a new evidence table cannot be left out of the backup by accident.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
BACKUP = (ROOT / "scripts/backup-corpus.mjs").read_text()
HEALTH = (ROOT / "scripts/ops-health.mjs").read_text()


def _scheduled() -> dict[str, str]:
    return {path.name: path.read_text() for path in sorted(WORKFLOWS.glob("*.yml")) if "\n  schedule:\n" in path.read_text()}


def _js_string_array(source: str, name: str) -> list[str]:
    match = re.search(rf"const {name} = \[(.*?)\];", source, re.DOTALL)
    assert match, f"{name} not found"
    return re.findall(r'"([a-z_]+)"', match.group(1))


def _js_object_keys(source: str, name: str) -> list[str]:
    match = re.search(rf"const {name} = \{{(.*?)\n\}};", source, re.DOTALL)
    assert match, f"{name} not found"
    return re.findall(r"^\s+([a-z_]+):", match.group(1), re.MULTILINE)


def _migration_tables() -> set[str]:
    created: set[str] = set()
    for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
        sql = path.read_text().casefold()
        created |= set(re.findall(r"create table (?:if not exists )?public\.([a-z_]+)", sql))
        created -= set(re.findall(r"drop table (?:if exists )?public\.([a-z_]+)", sql))
    return created


class OpsWorkflowTests(unittest.TestCase):
    def test_every_scheduled_workflow_reports_to_the_ops_alert_issue(self) -> None:
        scheduled = _scheduled()
        self.assertGreaterEqual(len(scheduled), 7, "the scan found the scheduled workflows")
        for name, source in scheduled.items():
            with self.subTest(workflow=name):
                if name == "ops-health.yml":
                    # The health check raises its own alert with --alert rather than the per-workflow step.
                    self.assertIn("node scripts/ops-health.mjs --alert", source)
                else:
                    step = re.search(
                        r"- uses: \./\.github/actions/ops-alert\n\s+if: \$\{\{ always\(\) \}\}\n\s+with:\n\s+status: \$\{\{ job\.status \}\}",
                        source,
                    )
                    self.assertIsNotNone(step, "ends with the ops-alert step, run always, with the job's status")
                self.assertIn("  issues: write\n", source)

    def test_the_health_check_watches_every_other_scheduled_workflow(self) -> None:
        watched = set(re.findall(r'\{ file: "([a-z-]+\.yml)"', HEALTH))
        self.assertEqual(watched, set(_scheduled()) - {"ops-health.yml"})

    def test_collection_health_raises_its_alert_from_regeneration(self) -> None:
        self.assertIn("node scripts/collection-health.mjs --alert", (WORKFLOWS / "forecast-regeneration.yml").read_text())

    def test_the_trim_runs_after_collection_and_reports_apart_from_it(self) -> None:
        """The trim is its own step, so its time is not counted as collection's.

        A collection run's `elapsed_seconds` is the measurement the company-batch rollout is judged on, and the trim
        happens in the database at a different cost entirely. It also never fails the run: the corpus is collected by
        then, and the next run trims what this one did not.
        """
        source = (WORKFLOWS / "current-jobs.yml").read_text()
        self.assertIn("python -m firstseen.cli trim-text", source)
        self.assertLess(
            source.index("trim-text"), source.index("Publish collection summary"), "the trim runs before the summary"
        )
        self.assertGreater(
            source.index("trim-text"), source.index("--collection current"), "and after collection"
        )
        step = source[source.index("- name: Trim out-of-scope text") : source.index("trim-text")]
        self.assertIn("continue-on-error: true", step)

    def test_a_disabled_source_is_not_reported_as_failing(self) -> None:
        """A streak is read from history, and turning a source off does not change history.

        Four sources were disabled on 2026-09-20 -- three closed postings that answer 404 for ever, one page that
        answers 403 -- and their streaks would have warned for the rest of the fourteen-day lookback, asking the owner
        to act on work that will never run again. The check reads `enabled` and reports only sources still collected.
        """
        health = (Path(__file__).resolve().parents[2] / "scripts/collection-health.mjs").read_text()
        self.assertIn("sources?select=id,url,adapter,enabled,companies(name)", health)
        self.assertIn(".filter((entry) => entry.source?.enabled)", health)

    def test_the_report_counts_every_table_in_one_request(self) -> None:
        """Migration 202608140056: nineteen tables in one read, none of it a whole-table count.

        054 replaced thirty-eight concurrent counts with nineteen sequential exact ones. That ended the concurrency
        failure and bought a slower one: an exact count is O(all rows), so it had no headroom, and once the corpus
        tripled the function answered HTTP 500 on every run from 2026-10-03 for thirteen days. The 24-hour `added`
        figure stays exact because a timestamp index bounds it; the row count is the catalogue's estimate, and the
        report says which is which. Accurate-until-it-dies is worse than a labelled estimate.
        """
        health = (ROOT / "scripts/collection-health.mjs").read_text()
        self.assertIn("rpc/counted_table_totals", health)
        # The code form, not the comments that explain why they are gone.
        self.assertNotIn('prefer: "count=exact"', health, "a per-table count is back; the fan-out is what failed")
        self.assertNotIn("rpc/corpus_text_sizes", health)
        # The estimate is labelled wherever a reader sees it, and never the thing a warning turns on.
        self.assertIn("Rows (estimate)", health)
        self.assertIn("not analysed", health)
        self.assertIn("fetches.estimate !== 0 && fetches.added === 0", health)

        migration = (ROOT / "supabase/migrations/202608140056_bounded_health_reads_and_failure_streaks.sql").read_text()
        body = migration[migration.index("create or replace function public.counted_table_totals") :]
        counted = {
            "companies": "created_at", "sources": "created_at", "source_fetches": "fetched_at",
            "raw_job_observations": "created_at", "archive_captures": "created_at",
            "canonical_roles": "created_at", "observation_role_matches": "created_at",
            "role_aliases": "created_at", "historical_opening_events": "created_at",
            "signals": "created_at", "forecasts": "created_at", "forecast_evidence": "created_at",
            "forecast_changes": "created_at", "readiness_milestones": "created_at",
            "inference_decisions": "decided_at", "model_usage": "created_at",
            "agent_runs": "started_at", "agent_tool_calls": "started_at", "backtest_runs": "created_at",
        }
        tables = _migration_tables()
        for table, column in counted.items():
            with self.subTest(table=table):
                self.assertIn(table, tables, "the counted table is one a migration creates")
                # The filtered count only. A bare `count(*) from public.<table>` is the thing that timed out.
                self.assertIn(f"count(*) filter (where {column} >= p_since) from public.{table}", body)
                self.assertNotIn(f"count(*) from public.{table}", body)
        self.assertIn("reltuples", body, "the total is the catalogue's estimate now")
        # Null, not zero, for a table that has never been analysed: zero would read as an empty table.
        self.assertIn("case when t.reltuples < 0 then null else t.reltuples::bigint end", body)

    def test_the_size_tripwire_cannot_be_slowed_by_anything_else(self) -> None:
        """The storage ceiling is read on its own, because it is the one number that must never be unavailable.

        The database goes read-only at 8 GiB, which stops collection and every write the site makes. 054 folded the
        size into the table-count read to save a request, so when that read started timing out the tripwire went dark
        with it for thirteen days. It is its own argumentless catalogue read now.
        """
        migration = (ROOT / "supabase/migrations/202608140056_bounded_health_reads_and_failure_streaks.sql").read_text()
        self.assertIn("create or replace function public.database_size_bytes()", migration)
        size = migration[migration.index("create or replace function public.database_size_bytes") :]
        self.assertIn("pg_database_size(current_database())", size)
        for forbidden in ("count(", "join", "public."):
            self.assertNotIn(forbidden, size.split("$$;")[0].split("as $$")[1], f"the tripwire reads {forbidden}")
        health = (ROOT / "scripts/collection-health.mjs").read_text()
        self.assertIn("rpc/database_size_bytes", health)
        self.assertNotIn("row.database_bytes", health, "the tripwire is back on the table read")

    def test_a_failed_read_says_which_sqlstate(self) -> None:
        """A 500 with no code cost two weeks of inferring a timeout we could never confirm.

        The body stays out, because a PostgREST error body can quote the query and the data. The five-character
        SQLSTATE goes in: 57014 is a statement timeout and says so in one run.
        """
        for script in ("scripts/collection-health.mjs", "scripts/measure-growth.mjs"):
            with self.subTest(script=script):
                source = (ROOT / script).read_text()
                self.assertIn("SQLSTATE", source)
                self.assertIn("[0-9A-Z]{5}", source)

    def test_a_failure_streak_is_defined_once(self) -> None:
        """`sources show` and the health report must not disagree about what a streak is.

        The definition lived only inside `collection-health.mjs`, so when that died on 2026-10-03 nothing could
        answer "which sources are failing and why": `sources show` listed a company's sources without their streaks,
        and the alert named a company and an adapter but no id. It is one SQL function now.
        """
        migration = (ROOT / "supabase/migrations/202608140056_bounded_health_reads_and_failure_streaks.sql").read_text()
        self.assertIn("create or replace function public.source_failure_streaks(", migration)
        streaks = migration[migration.index("create or replace function public.source_failure_streaks") :]
        # The report's semantics, unchanged: running ignored, newest first, the run before the first non-failure.
        self.assertIn("c.status <> 'running'", streaks)
        self.assertIn("order by c.started_at desc, c.id desc", streaks)
        self.assertIn("min(rn) as first_success", streaks)
        self.assertIn("least(greatest(coalesce(p_days, 14), 1), 90)", streaks)
        for signature in (
            "public.counted_table_totals(timestamptz)",
            "public.database_size_bytes()",
            "public.source_failure_streaks(uuid, integer)",
        ):
            self.assertIn(f"revoke all on function {signature} from public, anon, authenticated;", migration)
            self.assertIn(f"grant execute on function {signature} to service_role;", migration)
        # The command that asks the question reports it per source.
        takedown = (ROOT / "worker/src/firstseen/takedown.py").read_text()
        self.assertIn("source_failure_streaks", takedown)
        # Null when the function is not deployed, an empty list when it is and the source is clean: a diagnostic
        # must answer while part of what it reads is missing, and absent must not look like fine.
        self.assertIn('"failing": None if streaks is None else streaks.get(str(row["id"]), [])', takedown)
        self.assertIn("PGRST202", (ROOT / "worker/src/firstseen/repository.py").read_text())

    def test_a_dead_enrichment_skip_raises_an_alert(self) -> None:
        """The skip is 70% of a collection run and has silently stopped working three times.

        Migration 046 hashed the whole row including text and always timed out; 049 fixed that and the skip was still
        dead because `save_signal_observation` keyed on the raw byte hash; it was dead again on 2026-10-16, with
        `companies_unchanged: 0` across 80 companies and 1,782 of 2,535 seconds spent in enrichment. Each time it was
        found by reading a run summary weeks later. It is a warning now, from the per-company tool calls the skip
        records, with a floor so a handful of genuinely new companies does not cry wolf.
        """
        health = (ROOT / "scripts/collection-health.mjs").read_text()
        self.assertIn("ENRICHMENT_SKIP_FLOOR", health)
        self.assertIn("tool_name=eq.enrichment.company", health)
        # The recorded marker, which `enrichment_fingerprints.py` owns.
        self.assertIn("skipped_inputs_unchanged", health)
        self.assertIn("Enrichment skip is not firing", health)
        self.assertIn("skips.considered >= ENRICHMENT_SKIP_FLOOR && skips.skipped === 0", health)
        # The marker the report matches on has to be the one the worker writes.
        self.assertTrue(
            (ROOT / "worker/src/firstseen/enrichment_fingerprints.py").read_text().count(
                'UNCHANGED_RESULT = "skipped_inputs_unchanged'
            ),
            "the report matches a marker the worker no longer writes",
        )

    def test_source_freshness_is_watched_per_source_not_per_run(self) -> None:
        """A run can report success while never reaching the end of a stable source order.

        Today a run that cannot finish is killed at its 45-minute timeout and GitHub says cancelled, which is loud.
        A budgeted run would exit cleanly, collect the same head every time, never reach the tail, and report
        success -- a visible failure traded for an invisible one, whose first symptom is forecasts going stale for
        companies nobody can name. So freshness is read from each source's own `last_fetched_at`, never from whether
        a run succeeded, and a source that has never been fetched is the worst case rather than an absent one.
        """
        health = (ROOT / "scripts/collection-health.mjs").read_text()
        self.assertIn("SOURCE_STALE_AFTER_HOURS", health)
        self.assertIn("last_fetched_at", health)
        self.assertIn("Sources not being reached", health)
        self.assertIn("Sources never fetched", health)
        # Read per source over the sources table, not derived from a run's own report of itself.
        self.assertIn('all("sources?select=id,url,adapter,last_fetched_at&enabled=is.true&order=id.asc")', health)

    def test_every_table_is_backed_up_or_left_out_with_a_reason(self) -> None:
        backed_up = _js_string_array(BACKUP, "CORPUS_TABLES")
        left_out = _js_object_keys(BACKUP, "NOT_BACKED_UP")
        self.assertEqual(len(backed_up), len(set(backed_up)))
        self.assertFalse(set(backed_up) & set(left_out), "a table is both backed up and left out")
        tables = _migration_tables()
        self.assertIn("raw_job_observations", tables, "the scan found the migrations' tables")
        self.assertEqual(sorted(tables - set(backed_up) - set(left_out)), [], "tables in neither list")
        self.assertEqual(sorted((set(backed_up) | set(left_out)) - tables), [], "listed tables no migration creates")
        for table in ("raw_job_observations", "historical_opening_events", "archive_captures", "forecasts"):
            self.assertIn(table, backed_up)

    def test_no_action_metadata_holds_an_expression_outside_runs(self) -> None:
        """The runner evaluates ${{ }} anywhere in an action's metadata, descriptions included, and `job` does not exist
        there. The ops-alert action failed to load on every real run, so no failed workflow opened its issue, until its
        input description stopped quoting ${{ job.status }}."""
        actions = sorted((ROOT / ".github/actions").glob("*/action.yml"))
        self.assertTrue(actions, "the scan found the composite actions")
        for action in actions:
            metadata = action.read_text().split("\nruns:", 1)[0]
            with self.subTest(action=action.parent.name):
                self.assertNotIn("${{", metadata)

    def test_the_backup_restores_before_it_is_kept(self) -> None:
        source = (WORKFLOWS / "backup-corpus.yml").read_text()
        dump = source.index("node scripts/backup-corpus.mjs dump backup")
        prove = source.index("node scripts/backup-corpus.mjs prove-restore backup")
        encrypt = source.index("--symmetric --cipher-algo AES256")
        keep = source.index("actions/upload-artifact@v4")
        self.assertLess(dump, prove)
        self.assertLess(prove, encrypt)
        self.assertLess(encrypt, keep)
        # The repository is public: the artifact holds the encrypted archive and the manifest, never the plaintext dump.
        artifact = source[keep:]
        self.assertIn("backup/corpus.dump.gpg", artifact)
        self.assertIn("backup/manifest.json", artifact)
        self.assertNotRegex(artifact, r"path: backup/\s*$|backup/corpus\.dump\s*$", "the plaintext archive is never uploaded")
        self.assertIn("rm backup/corpus.dump", source)
        self.assertIn("secrets.BACKUP_ENCRYPTION_PASSPHRASE", source)
        # The restore server must be able to install pgvector (migration 202608140001); postgres:17-alpine cannot.
        self.assertIn("image: pgvector/pgvector:pg17", source)
        self.assertNotIn("postgresql://postgres:restore-proof-only@", source.replace(
            "postgresql://postgres:restore-proof-only@127.0.0.1:5432/postgres", ""
        ), "the only connection string in the workflow is the throwaway restore container's")


if __name__ == "__main__":
    unittest.main()
