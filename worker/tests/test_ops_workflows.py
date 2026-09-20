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
