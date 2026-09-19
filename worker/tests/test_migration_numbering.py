"""Migrations are numbered once each, in one contiguous sequence.

Supabase orders migrations by the version before the first underscore and records each version once. Two branches that
each add "the next" migration can both pick the same number and still apply cleanly on their own; merged, one silently
shadows the other or the pair applies in the wrong order. Merging three branches enumerated every branch's versions
(202608140035 to 202608140041, no two alike); this keeps it that way.
"""

from __future__ import annotations

import re
import unittest
from collections import Counter
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase/migrations"
NAME = re.compile(r"^(\d{12})_[a-z0-9_]+\.sql$")


def versions(names: list[str]) -> list[str]:
    return [match.group(1) for name in names if (match := NAME.match(name))]


def problems(names: list[str]) -> list[str]:
    """Every way a list of migration file names breaks the numbering rule."""
    found = [f"{name} is not <12-digit version>_<snake_case>.sql" for name in names if not NAME.match(name)]
    counts = Counter(versions(names))
    found += [f"version {version} is used by {count} migrations" for version, count in sorted(counts.items()) if count > 1]
    by_day: dict[str, list[int]] = {}
    for version in counts:
        by_day.setdefault(version[:8], []).append(int(version[8:]))
    for day, numbers in sorted(by_day.items()):
        missing = sorted(set(range(min(numbers), max(numbers) + 1)) - set(numbers))
        found += [f"{day}{number:04d} is missing from the {day} sequence" for number in missing]
    return found


class MigrationNumberingTest(unittest.TestCase):
    def test_the_checker_catches_a_shared_number_and_a_gap(self) -> None:
        self.assertEqual(problems(["202608140001_a.sql", "202608140002_b.sql"]), [])
        self.assertEqual(
            problems(["202608140001_a.sql", "202608140002_b.sql", "202608140002_c.sql"]),
            ["version 202608140002 is used by 2 migrations"],
        )
        self.assertEqual(problems(["202608140001_a.sql", "202608140003_c.sql"]), ["202608140002 is missing from the 20260814 sequence"])
        self.assertEqual(len(problems(["202608140001-a.sql"])), 1)

    def test_no_two_migrations_share_a_number_and_none_is_skipped(self) -> None:
        names = sorted(path.name for path in MIGRATIONS.glob("*.sql"))
        self.assertGreaterEqual(len(names), 41, "the scan found the migrations")
        self.assertEqual(problems(names), [])


if __name__ == "__main__":
    unittest.main()
