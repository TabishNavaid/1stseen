# Application Readiness Planner methodology

The Application Readiness Planner converts a statistical opening forecast into an actionable work-back
schedule. It is deterministic and versioned. No LLM selects dates, lead times, relevance, or adjustments.

## Inputs and outputs

The planner requires the forecast's as-of date, expected opening date, prediction interval, confidence,
and stable role/forecast identifiers. Its explicit context contains company size, recruiting scale from
0–1, role competitiveness from 0–1, role family, and an optional portfolio-relevance override.

Every plan preserves the predicted opening interval and produces:

- networking start;
- target date for identifying referral contacts;
- resume-ready deadline;
- portfolio/project-ready deadline for relevant role families; and
- high-alert monitoring date.

Each milestone includes its actionable date, uncompressed ideal date, effective lead days, immediate-work
flag, policy version, rationale, and all five numeric adjustments.

## Version 1 lead-time policy

The base and minimum lead times are measured backward from the prediction interval start:

| Milestone | Base days | Minimum days |
| --- | ---: | ---: |
| Networking | 63 | 28 |
| Identify referral contacts | 49 | 21 |
| Portfolio/projects ready | 35 | 14 |
| Resume ready | 28 | 14 |
| High-alert monitoring | 7 | 3 |

The planner calculates one transparent adjustment `A` for the plan:

`A = clamp(size + scale + competitiveness + interval uncertainty + low confidence, -10, 35)`

- Company-size adjustment: startup −7, small −3, medium 0, large +5, enterprise +9, unknown 0.
- Recruiting-scale adjustment: `round((scale - 0.5) × 14)`.
- Competitiveness adjustment: `round((competitiveness - 0.5) × 18)`.
- Interval-width adjustment: three days per week beyond a 14-day interval, capped at +18 days.
- Low-confidence adjustment: two days per five percentage points below 70%, capped at +16 days.

For milestone `m`, `lead(m) = max(minimum(m), base(m) + A)`. The ideal deadline is
`interval_start - lead(m)`. If that ideal date is already in the past, the actionable date becomes the
forecast as-of date and the milestone is explicitly marked immediate; the ideal date is retained for
explanation and audit.

Wider intervals and lower confidence can only move preparation earlier. Company scale and role
competitiveness reflect the additional time needed for structured, competitive recruiting programs.
Small-company plans can use shorter leads, subject to the milestone minimums.

Portfolio preparation is included by default for software engineering, data science, machine learning,
design, product design, and game development. A resolved role may explicitly override that inference.

## Persistence and evolution

Authenticated plans are stored per user, forecast, milestone kind, and policy version. Stored rows retain
the forecast interval, ideal/actionable dates, lead days, rationale, and adjustment payload. Watchlist and
readiness questions query these records rather than recomputing a second set of dates.

Changing a lead time, formula, cap, company-size mapping, or portfolio rule requires a new policy version,
tests, this document, and a compatible migration. Historical plans must not be rewritten in place.
