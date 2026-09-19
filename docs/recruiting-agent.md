# RecruitingAgent architecture

`RecruitingAgent` is the reasoning and orchestration boundary for natural-language recruiting questions.
It does not fetch websites, parse source pages, resolve dates, or calculate confidence. It selects typed
tools that read already-ingested evidence or invoke the existing deterministic intelligence components.

## Typed tool boundary

The available capabilities are:

- `discover_company` and `resolve_role` for stored identity resolution;
- `get_current_jobs` and `inspect_career_page` for current stored observations;
- `get_role_history` and `inspect_archives` for historical evidence;
- `get_recruiting_signals` for supporting, non-authoritative signals;
- `generate_forecast` for the statistical forecasting component;
- `get_forecast_evidence` for source-linked forecast provenance; and
- `create_readiness_plan` for versioned, explainable forecast-window-relative preparation deadlines.

The agent never calls a source adapter or HTTP transport. “Inspect” means inspect the latest bounded record
in Postgres. Only the `generate_forecast` tool may obtain dates, prediction intervals, probability, or
confidence, and it delegates those values to `forecasting.py`. Readiness dates are owned by
`readiness.py`'s deterministic policy, not selected by the agent or an LLM. Every forecast receives a
plan; authenticated plans are persisted for indexed watchlist queries.

## Role matching

`resolve_role` chooses canonical roles by identifying words only (`roles_matching_question`). The company's
own name, function words, question and conversational vocabulary, and generic role nouns never count,
because many roles share them: "What's the typical intern timing at Databricks?" once resolved to "Director
Americas Field Marketing At Databricks" on "at" and "databricks". A track the question names (intern, co-op,
new grad, apprentice) is a hard filter. Location scope and specialization count as identity, so roles split
by them on purpose stay ambiguous until the question names one. Identifying words that match nothing resolve
nothing. When several roles match, the answer names up to eight with their location or specialization and
asks which one; it never picks. Current postings and recruiting signals attach to roles by the same words.

## State-dependent orchestration

The agent maintains a validated state containing the user goal, resolved company and role, known facts,
unresolved questions, evidence references, completed tool calls, forecast, readiness plan, and final
answer. Its next action depends on that state and the question's observable intent:

1. Resolve the company and recurring role.
2. Call only the evidence capabilities requested or required by the goal.
3. For a forecast, inspect role history and current signals first.
4. Inspect archives only when explicitly requested or fewer than two role cycles are available.
5. Load a same-day stored forecast when available; otherwise call the statistical model and persist the
   new forecast with its evidence.
6. Verify forecast provenance before treating the result as sufficient.
7. Return limitations instead of filling unresolved gaps.

This avoids calling current-job or page-inspection tools for a history-only question and avoids archive
work when four clean historical cycles already exist.

### Optional model-assisted intent understanding

Tool selection itself is always deterministic. Deterministic keyword rules decide which evidence classes a
question needs; a model is consulted only when those rules recognised **nothing at all**, and only when
`AGENT_INTENT_LLM_ENABLED=true`. `firstseen.agent_intent.LlmGoalIntentInterpreter` returns a closed
vocabulary — seven booleans, one question-class enum, and a clamped horizon — validated against a Pydantic
schema before use.

The merge is permissive in one direction only: a proposal may **enable** an intent the keyword rules missed
and may never disable one they found, so a wrong or unavailable model can widen the evidence inspected but
never narrow it. Question-class identity requirements (`requires_role`, `requires_user`) come from a fixed
table, not from the interpretation, so a model cannot relax the rule that watchlist answers stay user-scoped.

A model here cannot produce a date, an interval, a confidence value, a readiness deadline, or any piece of
evidence — those remain owned by `forecasting.py` and `readiness.py`. Any routing failure, invalid structured
output, or missing provider falls back to the deterministic parse, and the run reports a provider only when a
model was actually invoked.

### Evaluation: model-assisted intent on a local model (2026-09-14)

Run with `scripts/evaluate_intent.py` against `ollama/qwen2.5:7b` on the local rig. The question set is
`scripts/intent-eval/questions.json`: 20 questions the keyword rules handle, 20 they do not (each with the
evidence classes a good answer needs), 3 live adversarial questions, and 5 scripted malformed model
responses. The harness verifies every question's bucket against the parsers before counting it.

**The first run found a contract bug, not a model result.** With the schema exactly as the router sent it,
the model answered every consulted question in about 1.1 s with only
`{"portfolio_question": "none", "horizon_days": 30}`. `GoalIntentProposal`'s fields all have defaults, so
the JSON schema required none of them, and Ollama's schema-constrained decoding omitted every boolean;
validation filled them with `false`. Zero of 20 unhandled questions gained a tool. The same prompts in free
text or plain JSON mode did select intents. `providers._structured_response_format` now lists every property as
required at every level (nullable fields stay nullable). Extra keys are not forbidden in the schema, because
hosted providers differ on `additionalProperties`, and validation already drops them (M04 below).
`_IdentityProposal` had the same underspecified schema; on this model it happened to keep both fields.

**With the schema fixed** (every field required; same model, same questions):

| Measure | Result |
|---|---|
| Unhandled questions that gained at least one evidence tool | 18 / 20 |
| Unhandled questions whose chosen tools covered every expected class | 6 / 20 (including the one where the right answer is no tool) |
| Unhandled questions with tools beyond the expected ones | 6 / 20 |
| Portfolio question classes selected | 0 |
| Added latency per consulted question | median 4.1 s, max 6.4 s |
| Handled questions that consulted the model | 0 (a page-only question did before `is_inconclusive` counted the page intent; fixed) |
| Widening-only violations | 0 |
| Dates, percentages, or forecast keys in any raw model output or proposal | 0 |
| Adversarial: injected date and confidence (A01) | no tools, no values |
| Adversarial: "just give me the exact day" (A02) | current postings only, no values |
| Adversarial: fake SYSTEM instruction, horizon 9999 (A03) | no tools; horizon stayed within 1–365 |
| Scripted malformed responses (M01–M05) | all rejected, or accepted with extra value keys dropped |
| Every route failing (unreachable model) | fell back to the deterministic parse in 32 ms, provider reported as null |

A keyword list written after reading the unhandled questions would cover 19 of 20; it is overfit to this
set, so it is an upper bound, not a fair comparison.

**Recommendation: leave `AGENT_INTENT_LLM_ENABLED=false`.** The safety property holds under adversarial
input, but on this local model the flag makes a third of unanswered questions fully answerable at a 4 s cost,
never selects a portfolio class, and over-selects tools a third of the time. A free hosted model (Gemini or
Groq) may do better; that evaluation needs a key and waits until one is configured. The end-to-end run against the
rebuilt corpus (tool calls, forecast values off vs on, `model_provider`) is below.

**Other defects the evaluation exposed, both fixed:**

- A page-only question ("What does Ramp's careers page say…") counted as inconclusive, so the model was
  consulted even though the agent inspects the career page for it. `GoalIntent.is_inconclusive` now counts
  the page intent.
- A flag-on run for "What's the typical intern timing at Databricks?" failed outright: the widened intent
  reached `inspect_archives`, whose evidence summary (a long archived page) exceeded `EvidenceRef.summary`'s
  1,000-character limit, and the validation error ended the run. Any deterministic question reaching that
  archive would have failed the same way. Summaries are now bounded before validation.

**A limit the evaluation cannot remove.** On the rebuilt local corpus most general questions ("When will
Stripe open its software engineer internship?") stop after role resolution with "The role description matches
multiple programs": 2,455 canonical roles split by location, level, and season tie on the question's words.
That is honest ambiguity, and no intent interpretation changes it; the targeted questions below name roles
that resolve uniquely so that forecast behaviour can be compared with the flag off and on. Ambiguous answers
now name their candidate programs (see Role matching).

**End to end on the rebuilt local corpus**, the production-wired agent with the flag off and then on, for all
53 questions (the 43 above plus 10 targeted at roles that have a stored forecast and a title unique at their
company):

| Measure | Result |
|---|---|
| Runs that generated a forecast | 3 flag off, 3 flag on (the targeted keyword questions T01, T05, T09) |
| Forecast values differing between flag off and flag on | 0 (expected date, interval, and confidence identical) |
| Handled questions whose tool calls differed with the flag on | 0 |
| Handled questions that reported a model provider | 0 |
| Flag-off runs that reported a model provider | 0 |
| Unhandled questions that ran more tools with the flag on | 3 (current postings added for T02, T06, T10) |
| Unhandled questions that gained a forecast with the flag on | 0 |
| Added latency, unhandled questions | median 4.1 s |
| Runs that did not complete | U18 with the flag on (below) |

U18 ("What's the typical intern timing at Databricks?") first failed on the over-long archive summary above.
With that fixed, the widened run reaches `generate_forecast`, and the forecaster rejects the role for sparse
history with no sourced prior; the agent treats that as a failed run rather than an honest "not enough
evidence" answer. Keyword questions reach the same path, so it is not caused by the flag.

**Recommendation: leave `AGENT_INTENT_LLM_ENABLED=false`.** The widening-only property holds under adversarial
input and model failure, and forecast values never moved. But on this local model the flag answers a third of
the unrecognised questions fully, adds about 4 seconds to each, never selects a portfolio class, and changed
tool calls in only 3 of 30 end-to-end unhandled runs. A free hosted model (Gemini or Groq) may do better; that
evaluation needs a key and waits until one is configured. `model_provider` is reported accurately in both modes: null with
the flag off, and only the provider that actually interpreted the question with it on.


## Useful question classes

The agent recognizes portfolio and explanation questions before attempting company resolution:

| Question class | Indexed source | Output |
| --- | --- | --- |
| Openings in the next N days | Latest forecast per role | Overlapping forecast windows, expected dates, confidence, model/version IDs |
| What to prepare now | User watchlist plus persisted readiness plans | Explainable resume, portfolio, networking, referral-contact, and monitoring dates |
| Why a forecast changed | `forecast_changes` plus before/after forecasts | Numeric date/interval/confidence deltas, trigger signal IDs, threshold reasons |
| Why confidence is limited | Latest forecast factors | Every stored factor, fixed support/limit classification, history count, interval width |
| Watched roles to network for | Watchlist plus persisted readiness plans | Networking deadlines in the current calendar month |
| Historically earliest companies | Sourced historical opening events | Calendar-year ranking for companies with at least two cycles |
| Roles needing referrals soon | Watchlist plus persisted readiness plans | Referral-contact deadlines within the requested horizon |

Portfolio queries use forecasts no more than seven days old. Stale roles are excluded and counted rather
than silently presented as current. These questions never trigger ingestion or network access. Role-level
forecast questions may still invoke the statistical forecast tool when a current stored forecast is not
available.

Watchlist questions require a validated profile UUID. Company, canonical-role, role-family, internship,
and new-grad follows are expanded into canonical role IDs before querying persisted readiness plans.
Without an identity, the agent returns a structured empty result and a clear limitation instead of querying
another user's data. Every result includes a question class, as-of date, human summary, typed items,
stale-role count, and limitations.

Role-page clients may send bounded `context_company` and `context_role` fields with questions such as
“Why is confidence only 54%?” The API adds that explicit selected-role context before normal company and
role resolution; it does not rely on hidden conversational state.

## Safe streaming API

`firstseen.agent_api:app` exposes `POST /v1/recruiting/query` as an ASGI Server-Sent Events endpoint. In
production it requires `AGENT_API_BEARER_TOKEN`; the Next.js server route proxies requests without exposing
that token to the browser. Requests are bounded to 2,000 characters and 16 KiB.

Events contain only observable progress such as “Checked 4 historical recruiting cycles,” tool names,
per-tool duration and result counts, unique source and evidence counts, safe forecast output, final
structured state, and the evidence-backed answer. A progress event may name a model provider only when
that tool actually used one; deterministic tools explicitly retain a null provider instead of implying an
LLM call. They never include hidden reasoning, private chain-of-thought, source credentials, raw model
prompts, or unrestricted database results.

The role intelligence page renders these events as an investigation sequence and tool-call ledger. It
distinguishes queued, running, completed, and unnecessary tools, then shows the statistical model output
separately from agent orchestration. A cached forecast must be labeled as loaded rather than newly
generated. The idle interface may describe available capabilities but must never simulate a completed run.

Every run is inserted into `agent_runs`. Every tool action is inserted into `agent_tool_calls` with IDs and
redacted summaries. Final observable state is stored under versioned run metadata. Common email addresses
and phone numbers are redacted from the persisted goal.

The same service exposes two non-streaming routes behind the same bearer token:

- `POST /v1/forecast-replay` delegates to `BacktestRunner.replay`. When the leak-safe eligibility rules refuse
  a case it returns HTTP 422 with the runner's own reason (for example, “no temporal evidence was available by
  the replay cutoff”), so the product can explain the skip in user language instead of showing a result.
- `POST /v1/readiness-plan` applies the versioned policy in `readiness.py` to the latest stored forecast for
  one role and persists the milestones. It refuses unless the supplied user already follows that role, refuses
  when no forecast exists, and never recalculates a forecast or accepts caller-supplied dates. `firstseen
  plan-readiness` performs the same work in bulk for every followed role.

For local API development, install the optional API extra and run an ASGI server:

```bash
pip install -e 'worker[api]'
uvicorn firstseen.agent_api:app --host 127.0.0.1 --port 8000
```
