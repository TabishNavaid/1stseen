"""Every column of the tables enrichment reads is either hashed in the fingerprint or excluded on purpose.

The fingerprint decides whether a company is skipped, so a column it does not cover is a column whose change can be
missed: the company looks unchanged and its evidence is never re-derived. Migration 046 got that safety by hashing
`to_jsonb(row)`, which covered a new column by default and cost 6 to 9 seconds for one company against an
eight-second statement timeout, so no company was ever skipped. Migration 049 hashes named columns instead, 36 times
faster, and this test is what replaces the default: a column added to one of these tables fails here until it is either
hashed or named as an exclusion with a reason.

The column lists below are a snapshot, checked against the migrations, so a schema change fails twice over: once
because the snapshot no longer matches the migrations, and once because the new column is covered by neither.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase/migrations"
FINGERPRINT = MIGRATIONS / "202608140049_fingerprints_without_the_text.sql"
MIN_REASON = 30

# Every column of every table the fingerprint covers, as the migrations declare them today.
COVERED_TABLES = {
    "raw_job_observations": {
        "id", "source_id", "observed_at", "fetched_at", "content_hash", "extraction_method", "http_status",
        "raw_text", "raw_payload", "embedding", "created_at", "external_job_id", "identity_key", "source_url",
        "apply_url", "raw_title", "company_name", "location", "employment_type", "published_at", "first_seen_at",
        "last_seen_at", "source_type", "source_reliability", "evidence_excerpt", "archive_capture_at", "archive_url",
        "archive_original_url", "archive_digest",
    },
    "observation_role_matches": {
        "observation_id", "canonical_role_id", "decision", "match_confidence", "feature_scores", "reasons",
        "evidence", "used_embedding", "used_llm", "resolver_version", "created_at", "inference_decision",
        "evidence_kind", "is_primary",
    },
    "canonical_roles": {
        "id", "company_id", "canonical_title", "track", "location_scope", "recurrence_key", "active", "created_at",
        "updated_at", "company_normalized", "normalized_title", "role_family", "level", "recruiting_season",
        "specialization", "feature_profile", "description_prototype", "description_embedding", "resolver_version",
        "scope_status", "scope_reason", "discipline", "early_career_type", "scope_evidence", "scope_method",
        "scope_classifier_version", "scope_classified_at", "superseded_by", "superseded_at", "forecast_refused_at",
        "forecast_refusal_reason",
    },
    "role_aliases": {
        "id", "canonical_role_id", "alias_title", "normalized_alias", "first_observation_id", "last_observation_id",
        "first_seen_at", "last_seen_at", "match_confidence", "match_evidence", "resolver_version", "created_at",
        "updated_at",
    },
    "historical_opening_events": {
        "id", "canonical_role_id", "observation_id", "opened_on", "closed_on", "evidence_quote", "source_quality",
        "extraction_version", "verified_at", "created_at", "opening_window_start", "opening_window_end",
        "date_precision", "uncertainty_days", "uncertainty_reason", "resolution_method", "provenance", "available_at",
    },
    "archive_captures": {
        "id", "source_id", "observation_id", "original_url", "archive_url", "captured_at", "status_code",
        "redirect_url", "archive_digest", "content_hash", "meaningful_hash", "change_kind", "completeness",
        "is_partial", "detected_titles", "evidence_excerpt", "created_at",
    },
}

# The alias the fingerprint gives each of those tables. One alias per table, so what is hashed can be read off.
ALIASES = {
    "o": "raw_job_observations",
    "m": "observation_role_matches",
    "r": "canonical_roles",
    "a": "role_aliases",
    "e": "historical_opening_events",
    "p": "archive_captures",
}


def declared_columns() -> dict[str, set[str]]:
    """Each covered table's columns, as the migrations create and alter them."""
    columns: dict[str, set[str]] = {table: set() for table in COVERED_TABLES}
    for path in sorted(MIGRATIONS.glob("*.sql")):
        sql = path.read_text()
        for table, table_columns in columns.items():
            for match in re.finditer(rf"create table public\.{table}\s*\((.*?)\n\);", sql, re.DOTALL):
                for line in match.group(1).splitlines():
                    name = re.match(r"\s{2,}([a-z_]+)\s", line)
                    if name and name.group(1) not in {"unique", "check", "primary", "foreign", "constraint"}:
                        table_columns.add(name.group(1))
            # One `alter table` may add or drop several columns, one per line, until the statement's semicolon.
            for match in re.finditer(rf"alter table (?:if exists )?public\.{table}\b(.*?);", sql, re.DOTALL):
                statement = match.group(1)
                for column in re.findall(r"add column (?:if not exists )?([a-z_]+)", statement):
                    table_columns.add(column)
                for column in re.findall(r"drop column (?:if exists )?([a-z_]+)", statement):
                    table_columns.discard(column)
    return columns


def hashed_columns() -> dict[str, set[str]]:
    sql = FINGERPRINT.read_text()
    body = sql[sql.index("create or replace function") :]
    found: dict[str, set[str]] = {table: set() for table in COVERED_TABLES}
    for alias, table in ALIASES.items():
        found[table] = set(re.findall(rf"\b{alias}\.([a-z_]+)", body))
    # The one path read out of a jsonb column counts as covering that column.
    if "raw_payload -> 'ats_categories'" in body:
        found["raw_job_observations"].add("raw_payload")
    return found


def excluded_columns() -> dict[str, list[str]]:
    """Each `-- excluded: table.column -- reason` line, with its reason."""
    excluded: dict[str, list[str]] = {}
    for table, column, reason in re.findall(
        r"-- excluded: ([a-z_]+)\.([a-z_]+) -- (.+)", FINGERPRINT.read_text()
    ):
        excluded.setdefault(table, []).append(column) if reason.strip() else None
    return excluded


def exclusion_reasons() -> dict[tuple[str, str], str]:
    return {
        (table, column): reason.strip()
        for table, column, reason in re.findall(
            r"-- excluded: ([a-z_]+)\.([a-z_]+) -- (.+)", FINGERPRINT.read_text()
        )
    }


class EnrichmentFingerprintCoverageTests(unittest.TestCase):
    def test_the_snapshot_matches_what_the_migrations_declare(self) -> None:
        declared = declared_columns()
        for table, expected in COVERED_TABLES.items():
            self.assertEqual(
                declared[table],
                expected,
                f"{table}'s columns changed. Update COVERED_TABLES, and hash the new column in "
                f"{FINGERPRINT.name} or name it there as an exclusion with a reason.",
            )

    def test_every_column_is_hashed_or_excluded_with_a_reason(self) -> None:
        hashed = hashed_columns()
        reasons = exclusion_reasons()
        uncovered: list[str] = []
        for table, columns in COVERED_TABLES.items():
            for column in sorted(columns):
                if column in hashed[table]:
                    continue
                reason = reasons.get((table, column))
                if reason is None or len(reason) < MIN_REASON:
                    uncovered.append(f"{table}.{column}")
        self.assertEqual(
            uncovered,
            [],
            "A column enrichment reads is neither hashed by the fingerprint nor excluded from it with a reason, so a "
            "change to it would leave the company looking unchanged and its evidence never re-derived.",
        )

    def test_the_reader_is_not_fooled_by_a_parse_that_found_nothing(self) -> None:
        hashed = hashed_columns()
        self.assertIn("content_hash", hashed["raw_job_observations"], "the hashed-column reader works")
        self.assertIn("is_primary", hashed["observation_role_matches"])
        self.assertIn("scope_status", hashed["canonical_roles"])
        self.assertGreaterEqual(len(exclusion_reasons()), 20, "the exclusion reader works")

    def test_the_text_columns_are_the_excluded_ones(self) -> None:
        """What 049 exists to stop hashing: the big text, each covered by a digest or not read at all."""
        reasons = exclusion_reasons()
        for table, column in (
            ("raw_job_observations", "evidence_excerpt"),
            ("raw_job_observations", "raw_text"),
            ("canonical_roles", "description_prototype"),
            ("historical_opening_events", "evidence_quote"),
            ("archive_captures", "evidence_excerpt"),
        ):
            self.assertIn((table, column), reasons, f"{table}.{column} must say why it is not hashed")

    def test_the_digests_that_stand_in_for_that_text_are_hashed(self) -> None:
        hashed = hashed_columns()
        self.assertIn("content_hash", hashed["raw_job_observations"])
        self.assertIn("content_hash", hashed["archive_captures"])
        self.assertIn("meaningful_hash", hashed["archive_captures"])


if __name__ == "__main__":
    unittest.main()
