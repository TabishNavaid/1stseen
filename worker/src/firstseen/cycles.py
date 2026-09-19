"""Recruiting-cycle identity: which opening events represent distinct cohorts.

A historical opening event is a *requisition publication*. A recruiting cycle is a
*cohort* — the annual instance of a recurring program. They are not the same thing,
and the forecasting model must count cohorts.

Live boards showed why: an evergreen full-time role is republished several times a
year, and every republication carries a genuine `first_published` timestamp. Counting
those as cycles inflates sample size and lets a role escape the sparse-history
confidence caps without any annual program existing.

Identity is established in two tiers:

1. Explicit cohort evidence supplied by the source — a recruiting season and/or an
   explicit target year in the posting title ("Software Engineer Intern (Fall 2026)").
   Two postings naming the same cohort are one cycle no matter how far apart they were
   published; two postings naming different cohorts are distinct cycles even if close.
2. No cohort evidence — identity is unknown. Distinctness cannot be demonstrated, so
   openings closer together than a recruiting year stay a single cycle. This is
   deliberately conservative: ambiguity collapses rather than inflating sample size.
"""

from __future__ import annotations

import re
from datetime import date

CYCLE_IDENTITY_VERSION = "recruiting-cycle-identity-v1"

# An annual program does not open twice within the same recruiting year. Openings
# closer than this without explicit cohort evidence are requisition refreshes, not
# separate cohorts. This is a cohort-identity rule, not the 45-day duplicate-evidence
# proximity threshold in `backtesting.CYCLE_MERGE_DAYS`, which remains unchanged.
ANNUAL_CYCLE_MIN_GAP_DAYS = 300

_SEASONS = ("spring", "summer", "fall", "autumn", "winter")
_YEAR = re.compile(r"\b(20[2-9][0-9])\b")
_SEASON = re.compile(r"\b(" + "|".join(_SEASONS) + r")\b", re.IGNORECASE)


def derive_cycle_key(
    title: str | None,
    recruiting_season: str | None,
    opened_on: date,
) -> str | None:
    """Return an explicit cohort key, or None when the source does not state one.

    The key is only built from evidence the source actually supplies. A season with
    no target year is not a cohort on its own — "Fall" repeats every year — so a year
    is required, taken from the title. `opened_on` is never used to invent a year,
    because publication year and target cohort year routinely differ (a Fall 2026
    internship is commonly posted in 2025).
    """
    text = title or ""
    year_match = _YEAR.search(text)
    if not year_match:
        return None
    year = year_match.group(1)

    season_match = _SEASON.search(text)
    season = (season_match.group(1).casefold() if season_match else (recruiting_season or "").casefold())
    if season == "autumn":
        season = "fall"
    if season not in _SEASONS:
        season = "unspecified"
    return f"{season}-{year}"


def group_indices_into_cycles(
    ordered: list[tuple[date, str | None]],
) -> list[int]:
    """Assign each chronologically ordered opening to a cycle index.

    `ordered` is a list of (opened_on, cycle_key) sorted by date. Events sharing an
    explicit cycle key always land in the same cycle. Events without a key start a new
    cycle only when they are an annual distance from the cycle they would otherwise
    join, so same-year reposts collapse.
    """
    assignments: list[int] = []
    key_to_cycle: dict[str, int] = {}
    next_cycle = 0
    anchor_by_cycle: dict[int, date] = {}
    last_unkeyed_cycle: int | None = None

    for opened_on, cycle_key in ordered:
        if cycle_key is not None:
            cycle = key_to_cycle.get(cycle_key)
            if cycle is None:
                cycle = next_cycle
                next_cycle += 1
                key_to_cycle[cycle_key] = cycle
                anchor_by_cycle[cycle] = opened_on
            assignments.append(cycle)
            continue

        if (
            last_unkeyed_cycle is not None
            and (opened_on - anchor_by_cycle[last_unkeyed_cycle]).days < ANNUAL_CYCLE_MIN_GAP_DAYS
        ):
            assignments.append(last_unkeyed_cycle)
            continue

        cycle = next_cycle
        next_cycle += 1
        anchor_by_cycle[cycle] = opened_on
        last_unkeyed_cycle = cycle
        assignments.append(cycle)
    return assignments
