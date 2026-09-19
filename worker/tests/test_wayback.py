import json
import sys
import unittest
from datetime import UTC, date, datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import FetchedDocument, JobCandidate, SourceConfig, build_observation
from firstseen.adapters.registry import AdapterRegistry
from firstseen.adapters.wayback import WaybackAdapter, meaningful_text
from firstseen.history import HistoricalOpeningResolver, RecurringRoleIdentity
from firstseen.models import HistoricalOpeningEvent
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000701")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
ROLE_ID = UUID("00000000-0000-4000-8000-000000000011")
OBSERVED_AT = datetime(2026, 8, 14, 10, tzinfo=UTC)


def fixture(name):
    return (FIXTURES / name).read_bytes()


class FakeTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, *, accept="*/*"):
        self.calls.append(url)
        body, content_type = self.responses[url]
        return FetchedDocument(url=url, status=200, content_type=content_type, body=body)


def source():
    return SourceConfig(
        id=SOURCE_ID,
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        adapter="wayback",
        url="https://careers.fixture.example/students",
        trust_score=0.85,
        options={"include_subpaths": True, "from": 2022, "to": 2024},
    )


def wayback_result():
    adapter = WaybackAdapter()
    configured = source()
    cdx_url = adapter.cdx_url(str(configured.url), configured)
    snapshots = {
        "20220801090000": "wayback_no_role.html",
        "20220910120000": "wayback_role_2022.html",
        "20220920120000": "wayback_role_2022_noise.html",
        "20230901090000": "wayback_no_role.html",
        "20230914100000": "wayback_changed_job_url.html",
        "20240918100000": "wayback_role_2024.html",
    }
    originals = {
        "20220801090000": "https://careers.fixture.example/students",
        "20220910120000": "https://careers.fixture.example/students",
        "20220920120000": "https://careers.fixture.example/students",
        "20230901090000": "https://careers.fixture.example/students",
        "20230914100000": "https://jobs.fixture.example/software-engineering-intern",
        "20240918100000": "https://careers.fixture.example/students",
    }
    responses = {cdx_url: (fixture("wayback_cdx.json"), "application/json")}
    for timestamp, fixture_name in snapshots.items():
        responses[adapter.archive_url(timestamp, originals[timestamp])] = (
            fixture(fixture_name),
            "text/html",
        )
    transport = FakeTransport(responses)
    return adapter.collect(configured, transport, observed_at=OBSERVED_AT), transport


class WaybackAdapterTests(unittest.TestCase):
    def test_queries_cdx_deduplicates_and_preserves_capture_semantics(self):
        result, transport = wayback_result()
        self.assertEqual(result.extraction_route, "archive")
        self.assertEqual(len(result.archive_captures), 7)
        self.assertTrue(any("cdx/search/cdx" in call for call in transport.calls))

        duplicate_state = next(
            capture
            for capture in result.archive_captures
            if capture.captured_at == datetime(2022, 9, 20, 12, tzinfo=UTC)
        )
        self.assertEqual(duplicate_state.change_kind, "unchanged")
        redirect = next(capture for capture in result.archive_captures if capture.status_code == 302)
        self.assertEqual(
            str(redirect.redirect_url), "https://jobs.fixture.example/software-engineering-intern"
        )

        archived_job = next(
            observation
            for observation in result.observations
            if observation.raw_title == "Software Engineering Internship"
        )
        self.assertIsNone(archived_job.published_at)
        self.assertEqual(archived_job.first_seen_at, OBSERVED_AT)
        self.assertEqual(archived_job.archive_capture_at, datetime(2022, 9, 10, 12, tzinfo=UTC))
        self.assertNotEqual(archived_job.first_seen_at, archived_job.archive_capture_at)

    def test_meaningful_change_hash_ignores_script_noise(self):
        first = meaningful_text(fixture("wayback_role_2022.html").decode())
        noisy = meaningful_text(fixture("wayback_role_2022_noise.html").decode())
        self.assertEqual(first, noisy)

    def test_ingestion_persists_capture_records_and_page_observations(self):
        _, transport = wayback_result()
        store = MemoryObservationStore()
        summary = SourceIngestionService(AdapterRegistry([WaybackAdapter()]), transport, store).ingest(
            source(), observed_at=OBSERVED_AT
        )
        self.assertEqual(len(store.archive_captures), 7)
        self.assertGreater(summary.created, len(store.archive_captures))
        self.assertTrue(all(capture.observation_id for capture in store.archive_captures.values()))

    def test_unavailable_snapshot_is_recorded_as_incomplete_evidence(self):
        adapter = WaybackAdapter()
        configured = source()
        cdx = json.dumps(
            [
                ["timestamp", "original", "statuscode", "digest", "mimetype", "redirect", "length"],
                ["20250101120000", str(configured.url), "200", "MISSING", "text/html", "-", "900"],
            ]
        ).encode()
        transport = FakeTransport(
            {adapter.cdx_url(str(configured.url), configured): (cdx, "application/json")}
        )
        result = adapter.collect(configured, transport, observed_at=OBSERVED_AT)
        self.assertFalse(result.complete)
        self.assertIn("archive_snapshot_unavailable", {item.code for item in result.diagnostics})
        self.assertEqual(result.archive_captures[0].change_kind, "unavailable")
        self.assertTrue(result.archive_captures[0].is_partial)
        events = HistoricalOpeningResolver().resolve(
            RecurringRoleIdentity(
                id=ROLE_ID,
                company_id=COMPANY_ID,
                company="Fixture Robotics",
                canonical_title="Software Engineering Intern",
                track="internship",
            ),
            captures=result.archive_captures,
            observations=result.observations,
        )
        self.assertEqual(events, [])

    def test_malformed_cdx_rows_are_skipped_with_counts(self):
        rows, invalid = WaybackAdapter._parse_cdx(fixture("wayback_cdx_malformed.json"))
        self.assertEqual(rows, [])
        self.assertEqual(invalid, 3)


class HistoricalOpeningResolverTests(unittest.TestCase):
    def setUp(self):
        self.role = RecurringRoleIdentity(
            id=ROLE_ID,
            company_id=COMPANY_ID,
            company="Fixture Robotics",
            canonical_title="Software Engineering Intern",
            track="internship",
            aliases=["Software Engineering Internship"],
        )

    def test_reconstructs_seeded_cycles_with_explicit_uncertainty(self):
        result, _ = wayback_result()
        current_source = SourceConfig(
            id=UUID("00000000-0000-4000-8000-000000000101"),
            company_id=COMPANY_ID,
            company="Fixture Robotics",
            adapter="generic",
            url="https://jobs.fixture.example/software-engineering-intern",
            trust_score=0.95,
        )
        exact = build_observation(
            current_source,
            JobCandidate(
                source_url="https://jobs.fixture.example/software-engineering-intern",
                apply_url="https://jobs.fixture.example/software-engineering-intern/apply",
                raw_title="Software Engineering Intern",
                company="Fixture Robotics",
                published_at=datetime(2023, 9, 11, tzinfo=UTC),
                external_job_id="swe-2023",
                evidence_excerpt="Published September 11, 2023",
                observation_id=UUID("00000000-0000-4000-8000-000000000811"),
            ),
            observed_at=datetime(2023, 9, 14, tzinfo=UTC),
            extraction_route="json_ld",
        )
        events = HistoricalOpeningResolver().resolve(
            self.role,
            captures=result.archive_captures,
            observations=[*result.observations, exact],
        )

        self.assertEqual([event.opened_on.year for event in events], [2022, 2023, 2024])
        first, second, third = events
        self.assertEqual(first.date_precision, "bounded")
        self.assertEqual(first.opening_window_start.isoformat(), "2022-08-02")
        self.assertEqual(first.opening_window_end.isoformat(), "2022-09-10")
        self.assertGreater(first.uncertainty_days, 0)
        self.assertEqual(second.date_precision, "exact")
        self.assertEqual(second.opened_on.isoformat(), "2023-09-11")
        self.assertTrue(any(item["kind"] == "archive_capture" for item in second.provenance))
        self.assertEqual(third.date_precision, "observed_by")
        self.assertIsNone(third.opening_window_start)
        self.assertIn("too distant", third.uncertainty_reason)

    def test_partial_and_redirect_captures_do_not_claim_absence(self):
        result, _ = wayback_result()
        captures = list(result.archive_captures)
        partial = captures[0].model_copy(
            update={
                "id": UUID("00000000-0000-4000-8000-000000000899"),
                "observation_id": UUID("00000000-0000-4000-8000-000000000898"),
                "captured_at": datetime(2022, 9, 5, tzinfo=UTC),
                "is_partial": True,
                "completeness": 0.2,
                "evidence_excerpt": "Loading",
                "detected_titles": [],
            }
        )
        captures.append(partial)
        events = HistoricalOpeningResolver().resolve(
            self.role,
            captures=captures,
            observations=result.observations,
        )
        event_2022 = next(event for event in events if event.opened_on.year == 2022)
        self.assertEqual(event_2022.opening_window_start.isoformat(), "2022-08-02")
        self.assertTrue(all(event.date_precision != "exact" for event in events))

    def test_existing_historical_first_seen_evidence_is_retained(self):
        prior = HistoricalOpeningEvent(
            id=UUID("00000000-0000-4000-8000-000000000821"),
            canonical_role_id=ROLE_ID,
            observation_id=UUID("00000000-0000-4000-8000-000000000822"),
            opened_on=date(2021, 9, 20),
            evidence_quote="First observed on the stored careers page",
            source_quality=0.65,
            opening_window_start=None,
            opening_window_end=date(2021, 9, 20),
            date_precision="observed_by",
            uncertainty_days=None,
            uncertainty_reason="No earlier stored observation is available.",
            resolution_method="stored_first_seen_v1",
            provenance=[{"kind": "stored_historical_first_seen"}],
        )
        events = HistoricalOpeningResolver().resolve(
            self.role,
            captures=[],
            observations=[],
            historical_first_seen=[prior],
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].opened_on, date(2021, 9, 20))
        self.assertEqual(events[0].provenance[0]["kind"], "stored_historical_first_seen")


if __name__ == "__main__":
    unittest.main()


class TimeMapFallbackTests(unittest.TestCase):
    """CDX enumeration can be unavailable while Memento TimeMap still serves captures."""

    def transport_with_failing_cdx(self):
        adapter = WaybackAdapter()
        configured = source()
        responses = {
            adapter.timemap_url(str(configured.url)): (
                fixture("wayback_timemap.link"),
                "application/link-format",
            )
        }
        snapshots = {
            "20220801090000": "wayback_no_role.html",
            "20220910120000": "wayback_role_2022.html",
            "20220920120000": "wayback_role_2022_noise.html",
            "20230901090000": "wayback_no_role.html",
            "20230914100000": "wayback_role_2022.html",
            "20240918100000": "wayback_role_2024.html",
        }
        for timestamp, name in snapshots.items():
            responses[adapter.archive_url(timestamp, str(configured.url))] = (
                fixture(name),
                "text/html",
            )

        class FailingCdxTransport(FakeTransport):
            def get(self, url, *, accept="*/*"):
                if "/cdx/search/cdx" in url:
                    raise OSError("cdx unavailable")
                return super().get(url, accept=accept)

        return adapter, configured, FailingCdxTransport(responses)

    def test_timemap_enumeration_recovers_captures_when_cdx_fails(self):
        adapter, configured, transport = self.transport_with_failing_cdx()
        result = adapter.collect(configured, transport, observed_at=OBSERVED_AT)

        codes = {item.code for item in result.diagnostics}
        self.assertIn("archive_index_fallback_timemap", codes)
        self.assertNotIn("cdx_target_collection_failed", codes)
        self.assertTrue(result.archive_captures, "TimeMap fallback produced no captures")
        # The configured 2022-2024 window excludes the 2025 capture in the fixture.
        years = {capture.captured_at.year for capture in result.archive_captures}
        self.assertEqual(years, {2022, 2023, 2024})

    def test_timemap_captures_still_reconstruct_bounded_openings(self):
        adapter, configured, transport = self.transport_with_failing_cdx()
        result = adapter.collect(configured, transport, observed_at=OBSERVED_AT)
        events = HistoricalOpeningResolver().resolve(
            RecurringRoleIdentity(
                id=ROLE_ID,
                company_id=COMPANY_ID,
                company="Fixture Robotics",
                canonical_title="Software Engineering Intern",
                track="internship",
            ),
            captures=result.archive_captures,
            observations=result.observations,
        )
        self.assertTrue(events)
        # Absence followed by presence must still yield a bounded window, and a
        # missing status code must never be promoted to an exact date.
        self.assertIn("bounded", {event.date_precision for event in events})
        self.assertNotIn("exact", {event.date_precision for event in events})
        for event in events:
            self.assertGreaterEqual(len(event.provenance), 1)

    def test_timemap_parsing_omits_metadata_it_cannot_observe(self):
        rows, invalid = WaybackAdapter._parse_timemap(fixture("wayback_timemap.link"))
        self.assertEqual(invalid, 0)
        self.assertTrue(rows)
        for row in rows:
            self.assertIn("timestamp", row)
            self.assertIn("original", row)
            # No status code, digest, or MIME type is invented from the index.
            self.assertNotIn("statuscode", row)
            self.assertNotIn("digest", row)


class ArchivePersistenceShapeTests(unittest.TestCase):
    """Real archived pages break assumptions that live ATS JSON never exercises."""

    def test_repeat_captures_of_unchanged_content_stay_distinct_observations(self):
        # The schema requires one observation per capture (observation_id is unique),
        # so two captures of an unchanged page must not collide on the
        # (source_id, content_hash) uniqueness.
        configured = source()
        base = {
            "source_url": str(configured.url),
            "apply_url": str(configured.url),
            "raw_title": "Archived recruiting page: careers.fixture.example",
            "company": "Fixture Robotics",
            "evidence_excerpt": "Software Engineering Internship applications are open.",
        }
        first = build_observation(
            configured,
            JobCandidate(**base, archive_capture_at=datetime(2022, 9, 10, 12, tzinfo=UTC)),
            observed_at=OBSERVED_AT,
            extraction_route="archive",
        )
        second = build_observation(
            configured,
            JobCandidate(**base, archive_capture_at=datetime(2023, 9, 8, 12, tzinfo=UTC)),
            observed_at=OBSERVED_AT,
            extraction_route="archive",
        )
        self.assertNotEqual(first.content_hash, second.content_hash)

    def test_live_source_content_hash_is_unaffected_by_the_archive_component(self):
        configured = source()
        candidate = JobCandidate(
            source_url="https://careers.fixture.example/jobs/1",
            apply_url="https://careers.fixture.example/jobs/1",
            raw_title="Software Engineer Intern",
            company="Fixture Robotics",
            evidence_excerpt="Build production software.",
        )
        twice = [
            build_observation(
                configured, candidate, observed_at=OBSERVED_AT, extraction_route="json_ld"
            ).content_hash
            for _ in range(2)
        ]
        self.assertEqual(twice[0], twice[1])

    def test_archived_binary_noise_is_removed_before_persistence(self):
        from firstseen.repository import bounded_utf8

        # Postgres text cannot store a NUL byte; archived HTML sometimes contains one.
        noisy = "Software Engineering Internship\x00\x08 applications\x1f open"
        cleaned = bounded_utf8(noisy, 65_536)
        self.assertNotIn("\x00", cleaned)
        self.assertEqual(cleaned, "Software Engineering Internship applications open")
