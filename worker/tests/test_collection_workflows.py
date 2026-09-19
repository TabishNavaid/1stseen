import re
import unittest
from pathlib import Path
from typing import get_args

from pydantic import HttpUrl

from firstseen.config import Settings

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"

COLLECTION = {
    "current-jobs.yml": "ingest --all --collection current",
    "career-page-signals.yml": "signals --all",
    "historical-enrichment.yml": "ingest --all --collection historical",
    "forecast-regeneration.yml": "regenerate-forecasts",
}
# Archive and page/sitemap/feed crawls revisit the same origins, so they use the
# slower courtesy interval.
COURTESY_PACED = {"career-page-signals.yml", "historical-enrichment.yml"}
WEEK_MINUTES = 7 * 24 * 60


def _read(filename: str) -> str:
    return (WORKFLOWS / filename).read_text()


def _blank_is_fatal(annotation: object) -> bool:
    """Settings refuses an empty string for a URL, number, or boolean field."""
    kinds = [kind for kind in (get_args(annotation) or (annotation,)) if kind is not type(None)]
    return any(kind is HttpUrl or kind in (int, float, bool) for kind in kinds)


def _timeout_minutes(source: str) -> int:
    match = re.search(r"^\s*timeout-minutes:\s*(\d+)\s*$", source, re.MULTILINE)
    assert match, "every collection job declares timeout-minutes"
    return int(match.group(1))


def _weekly_start_minutes(source: str) -> list[int]:
    """Start minutes within a Sunday-based week for the cron forms these workflows use."""
    starts: list[int] = []
    for cron in re.findall(r'^\s*- cron: "([^"]+)"', source, re.MULTILINE):
        minute, hour, day_of_month, month, day_of_week = cron.split()
        assert day_of_month == "*" and month == "*", f"unsupported cron {cron}"
        if hour == "*":
            hours = list(range(24))
        elif hour.startswith("*/"):
            hours = list(range(0, 24, int(hour[2:])))
        else:
            hours = [int(value) for value in hour.split(",")]
        days = range(7) if day_of_week == "*" else [int(value) for value in day_of_week.split(",")]
        starts += [day * 1440 + hour_value * 60 + int(minute) for day in days for hour_value in hours]
    return starts


class CollectionWorkflowTests(unittest.TestCase):
    def test_collection_workflows_are_scheduled_manual_and_serialized(self):
        for filename, command in COLLECTION.items():
            with self.subTest(workflow=filename):
                source = _read(filename)
                self.assertIn("schedule:", source)
                self.assertIn("workflow_dispatch:", source)
                # Previously `firstseen-collection-${{ github.ref }}`. Keying by ref let a
                # run dispatched from a branch write to the one production database beside
                # a scheduled run on main, so every writer now shares a single group.
                self.assertIn("  group: firstseen-collection\n", source)
                self.assertNotIn("github.ref", source)
                self.assertIn("cancel-in-progress: false", source)
                self.assertIn(command, source)
                self.assertIn("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}", source)
                self.assertIn("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}", source)
                self.assertIn("actions/upload-artifact@v4", source)

    def test_backtest_runs_monthly_and_by_hand_and_is_machine_readable(self):
        """Monthly, so the evaluable-case count is re-measured as evidence accumulates."""
        source = _read("backtest.yml")
        self.assertIn("workflow_dispatch:", source)
        self.assertEqual(re.findall(r'^\s*- cron: "([^"]+)"', source, re.MULTILINE), ["23 5 3 * *"])
        # A scheduled run has no inputs, so the cutoff falls back to the CLI default rather than an empty argument.
        self.assertIn("CUTOFF_DAYS: ${{ inputs.cutoff_days || '60' }}", source)
        self.assertIn("node scripts/backtest-history.mjs", source)
        self.assertIn("firstseen.cli \"${args[@]}\" > backtest-result.json", source)
        # Previously `firstseen-backtest-${{ github.ref }}`; see the collection group above.
        self.assertIn("  group: firstseen-backtest\n", source)
        self.assertNotIn("github.ref", source)

    def test_every_workflow_lifts_the_source_size_cap_with_a_literal_fallback(self):
        """config.py defaults to 2 MB, which rejects real ATS boards; an unset var must not restore it."""
        for filename in [*COLLECTION, "backtest.yml"]:
            with self.subTest(workflow=filename):
                self.assertIn(
                    "MAX_SOURCE_BYTES: ${{ vars.MAX_SOURCE_BYTES || '10000000' }}", _read(filename)
                )

    def test_archive_and_page_crawls_use_the_courtesy_interval(self):
        for filename in [*COLLECTION, "backtest.yml"]:
            with self.subTest(workflow=filename):
                expected = (
                    "${{ vars.COURTESY_HTTP_MIN_HOST_INTERVAL_SECONDS || '1.5' }}"
                    if filename in COURTESY_PACED
                    else "${{ vars.HTTP_MIN_HOST_INTERVAL_SECONDS || '0.25' }}"
                )
                self.assertIn(f"HTTP_MIN_HOST_INTERVAL_SECONDS: {expected}", _read(filename))

    def test_every_optional_typed_setting_a_workflow_passes_has_a_literal_fallback(self):
        """An unset repository variable reaches the job as an empty string, and Settings refuses an empty URL, number, or
        boolean at startup. Every collection run failed on LLM_API_BASE that way until it had a fallback.
        Required secrets such as SUPABASE_URL are meant to fail when missing."""
        typed = {field.alias for field in Settings.model_fields.values() if field.alias and _blank_is_fatal(field.annotation)}
        self.assertIn("LLM_API_BASE", typed, "the scan recognises a URL setting")
        for filename in sorted(path.name for path in WORKFLOWS.glob("*.yml")):
            for number, line in enumerate(_read(filename).splitlines(), 1):
                match = re.match(r"\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*vars\.[A-Z0-9_]+\s*(\|\|)?", line)
                if match and match.group(1) in typed:
                    with self.subTest(workflow=filename, line=number, name=match.group(1)):
                        self.assertTrue(match.group(2), "needs a literal fallback: ${{ vars.NAME || '<default>' }}")

    def test_the_literal_fallbacks_are_accepted_by_settings_and_lift_the_default(self):
        settings = Settings(_env_file=None, MAX_SOURCE_BYTES=10_000_000, HTTP_MIN_HOST_INTERVAL_SECONDS=1.5)

        self.assertEqual(settings.max_source_bytes, 10_000_000)
        self.assertEqual(settings.http_min_host_interval_seconds, 1.5)
        self.assertLess(Settings.model_fields["max_source_bytes"].default, 10_000_000)

    def test_scheduled_runs_cannot_overlap_even_at_their_full_timeout(self):
        """GitHub keeps one pending run per concurrency group and cancels the older pending
        run when another queues, so schedules that overlap would silently drop runs."""
        intervals = []
        for filename in COLLECTION:
            source = _read(filename)
            timeout = _timeout_minutes(source)
            intervals += [(start, start + timeout, filename) for start in _weekly_start_minutes(source)]
        intervals.sort()
        following = [*intervals[1:], (intervals[0][0] + WEEK_MINUTES, 0, intervals[0][2])]
        for (start, end, name), (next_start, _, next_name) in zip(intervals, following, strict=True):
            with self.subTest(after=name, before=next_name, starts_at_minute=start):
                self.assertGreaterEqual(next_start - end, 15)

    def test_forecast_regeneration_reports_collection_health(self):
        source = _read("forecast-regeneration.yml")
        self.assertIn("node scripts/collection-health.mjs", source)
        self.assertIn("actions: read", source)
        self.assertTrue((ROOT / "scripts/collection-health.mjs").exists())

    def test_legacy_combined_workflow_is_removed(self):
        self.assertFalse((WORKFLOWS / "ingest.yml").exists())

    def test_workflows_do_not_contain_credential_values(self):
        combined = "\n".join(path.read_text() for path in WORKFLOWS.glob("*.yml"))
        self.assertNotIn("service_role=", combined.casefold())
        self.assertNotIn("eyJhbGci", combined)
        self.assertNotIn("AIza", combined)


if __name__ == "__main__":
    unittest.main()
