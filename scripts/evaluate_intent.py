#!/usr/bin/env python3
"""Evaluate AGENT_INTENT_LLM_ENABLED against the deterministic intent parser.

Two layers, run separately:

  selection   Which typed tools each path selects, flag off and on, using the configured model
              (Ollama on the local rig). No database. Also runs the adversarial cases: live
              questions that try to make the model state a date or escape the classifier,
              scripted malformed model responses that never reach a provider, and a route
              failure.
  end-to-end  The production-wired RecruitingAgent against the rig corpus, flag off and on:
              tool calls, forecast values, model_provider, and the answer. Needs a corpus.

  .venv/bin/python scripts/evaluate_intent.py selection --out <file.json>
  .venv/bin/python scripts/evaluate_intent.py end-to-end --out <file.json>

The model is consulted exactly as RecruitingAgent consults it: only for a question the keyword
rules find inconclusive and no portfolio pattern matches. Every question's bucket is verified
against the parsers before its result is counted.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from firstseen.agent import (
    GoalIntent,
    RecruitingAgent,
    RecruitingTools,
    SupabaseRecruitingKnowledge,
)
from firstseen.agent_intent import LlmGoalIntentInterpreter
from firstseen.agent_questions import (
    SupabasePortfolioQueries,
    UsefulQuestionIntent,
    UsefulQuestionTools,
)
from firstseen.config import Settings
from firstseen.providers import CompletionResult, ModelRouter
from firstseen.readiness import SupabaseReadinessPlanStore
from firstseen.repository import IntelligenceRepository

ROOT = Path(__file__).resolve().parents[1]
QUESTIONS = ROOT / "scripts" / "intent-eval" / "questions.json"
FLAGS = ("current", "history", "archives", "forecast", "readiness", "signals", "page")
EVIDENCE = tuple(flag for flag in FLAGS if flag != "page")
# Anything that looks like a date, a percentage, or a forecast-value key.
# "production" sends the schema exactly as the router builds it; "all_required" is the
# experiment behind --require-all-fields.
SCHEMA_CONTRACT = "production"
VALUE_PATTERN = re.compile(
    r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,3}\s?(?:%|percent)|\"(?:expected_opening_date|interval_start|interval_end|confidence|calibrated_probability)\"",
    re.IGNORECASE,
)


def configured(**overrides: object) -> Settings:
    """Settings from .env plus overrides given by their environment names."""
    return Settings(**overrides)  # type: ignore[arg-type]


class CapturingClient:
    """Wraps a capability client to keep each raw model output, error, and latency."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls: list[dict[str, Any]] = []

    def complete(self, **kwargs: Any) -> CompletionResult:
        started = time.monotonic()
        try:
            result = self.inner.complete(**kwargs)
        except Exception as exc:
            self.calls.append({"latency_ms": _ms(started), "error": f"{type(exc).__name__}: {str(exc)[:240]}", "content": None})
            raise
        self.calls.append({"latency_ms": _ms(started), "error": None, "content": result.content})
        return result


class ScriptedClient:
    """A model that always answers with fixed content, for malformed-response cases."""

    def __init__(self, content: str) -> None:
        self.content = content

    def complete(self, **kwargs: Any) -> CompletionResult:
        del kwargs
        return CompletionResult(content=self.content, provider="scripted", model="scripted")


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def flags(intent: GoalIntent) -> dict[str, bool]:
    return {flag: bool(getattr(intent, flag)) for flag in FLAGS}


def values_in(text: str | None) -> list[str]:
    return VALUE_PATTERN.findall(text or "")


def classify(question: str) -> tuple[str, GoalIntent, UsefulQuestionIntent | None]:
    intent = GoalIntent.parse(question)
    useful = UsefulQuestionIntent.parse(question)
    return ("unhandled" if intent.is_inconclusive and useful is None else "handled"), intent, useful


def interpret(question: str, config: Settings) -> dict[str, Any]:
    bucket, intent, useful = classify(question)
    off = {"flags": flags(intent), "portfolio": useful.question_class if useful else None}
    if bucket == "handled":
        return {"bucket": bucket, "off": off, "on": {**off, "consulted": False, "provider": None}}
    client = CapturingClient(ModelRouter.from_settings(config).client("classify"))
    interpreter = LlmGoalIntentInterpreter(client)  # type: ignore[arg-type]
    started = time.monotonic()
    proposal = interpreter.interpret(question)
    latency_ms = _ms(started)
    widened = intent.widened_by(proposal) if proposal else intent
    chosen = (
        UsefulQuestionIntent.from_choice(proposal.portfolio_question, proposal.horizon_days)
        if proposal and proposal.portfolio_question != "none"
        else None
    )
    raw = next((call["content"] for call in reversed(client.calls) if call["content"] is not None), None)
    return {
        "bucket": bucket,
        "off": off,
        "on": {
            "flags": flags(widened),
            "portfolio": chosen.question_class if chosen else None,
            "consulted": True,
            "provider": interpreter.provider,
            "proposal": proposal.model_dump() if proposal else None,
            "raw_model_output": raw[:500] if raw else None,
            "model_errors": [call["error"] for call in client.calls if call["error"]],
            "latency_ms": latency_ms,
        },
    }


def widening_only(off: dict[str, bool], on: dict[str, bool]) -> bool:
    return all(on[flag] or not off[flag] for flag in FLAGS)


def run_selection(data: dict[str, Any], out: Path) -> None:
    config = configured(AGENT_INTENT_LLM_ENABLED=True)
    rows: list[dict[str, Any]] = []
    for group in ("handled", "unhandled", "adversarial_live", "targeted"):
        for item in data.get(group, []):
            result = interpret(item["question"], config)
            declared = item.get("bucket") or ("handled" if group == "handled" else "unhandled")
            row: dict[str, Any] = {"id": item["id"], "group": group, "question": item["question"], "declared_bucket": declared, **result}
            row["bucket_verified"] = result["bucket"] == declared
            row["widening_only"] = widening_only(result["off"]["flags"], result["on"]["flags"])
            if result["on"]["consulted"]:
                row["values_in_raw_output"] = values_in(result["on"]["raw_model_output"])
                row["values_in_proposal"] = values_in(json.dumps(result["on"]["proposal"])) if result["on"]["proposal"] else []
            if group == "unhandled" or (group == "targeted" and declared == "unhandled"):
                expected = set(item["expected"])
                chosen = {flag for flag in EVIDENCE if result["on"]["flags"][flag]}
                row["expected"] = sorted(expected)
                row["chosen"] = sorted(chosen)
                row["answerable_with_model"] = bool(chosen) or result["on"]["portfolio"] is not None
                row["covers_expected"] = expected <= chosen if expected else (not chosen and result["on"]["portfolio"] is None)
                row["extra_flags"] = sorted(chosen - expected)
                lowered = item["question"].casefold()
                rule_flags = {
                    flag
                    for term, mapped in data["hypothetical_keyword_rules"]["terms"].items()
                    if term in lowered
                    for flag in mapped
                }
                row["covered_by_hypothetical_rules"] = expected <= rule_flags if expected else not rule_flags
            rows.append(row)
            print(f"{item['id']} {result['bucket']:9} consulted={result['on']['consulted']} latency_ms={result['on'].get('latency_ms')}", file=sys.stderr, flush=True)

    scripted = []
    for item in data["adversarial_scripted"]:
        interpreter = LlmGoalIntentInterpreter(ScriptedClient(item["content"]))  # type: ignore[arg-type]
        proposal = interpreter.interpret("Tell me about the Stripe software engineer internship.")
        if proposal is None:
            outcome = "rejected"
        else:
            outcome = "accepted_with_values" if values_in(json.dumps(proposal.model_dump())) else "accepted_without_values"
        scripted.append({
            "id": item["id"], "content": item["content"], "expected": item["expect"], "outcome": outcome,
            "matches_expectation": outcome == item["expect"], "proposal": proposal.model_dump() if proposal else None,
        })

    unreachable = configured(AGENT_INTENT_LLM_ENABLED=True, OLLAMA_API_BASE="http://127.0.0.1:9", LLM_API_BASE="http://127.0.0.1:9")
    failure = interpret(data["unhandled"][0]["question"], unreachable)
    route_failure = {
        "question": data["unhandled"][0]["question"],
        "fell_back": failure["on"]["proposal"] is None and failure["on"]["flags"] == failure["off"]["flags"],
        "provider_reported": failure["on"]["provider"],
        "latency_ms": failure["on"]["latency_ms"],
        "model_errors": failure["on"]["model_errors"],
    }

    report = {"model_routes": config.routes_for("classify"), "schema_contract": SCHEMA_CONTRACT, "rows": rows, "scripted": scripted, "route_failure": route_failure}
    report["summary"] = summarize_selection(report)
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report["summary"], indent=2))


def summarize_selection(report: dict[str, Any]) -> dict[str, Any]:
    rows = report["rows"]
    handled = [row for row in rows if row["group"] == "handled"]
    unhandled = [row for row in rows if row["group"] == "unhandled"]
    live_adversarial = [row for row in rows if row["group"] == "adversarial_live"]
    consulted = [row for row in rows if row["on"]["consulted"]]
    latencies = [row["on"]["latency_ms"] for row in consulted if row["on"]["latency_ms"] is not None]
    return {
        "misbucketed": [row["id"] for row in rows if not row["bucket_verified"]],
        "handled_model_consulted": sum(row["on"]["consulted"] for row in handled),
        "unhandled_answerable_with_model": sum(row.get("answerable_with_model", False) for row in unhandled),
        "unhandled_covers_expected": sum(row.get("covers_expected", False) for row in unhandled),
        "unhandled_with_extra_flags": sum(bool(row.get("extra_flags")) for row in unhandled),
        "unhandled_covered_by_hypothetical_rules": sum(row.get("covered_by_hypothetical_rules", False) for row in unhandled),
        "model_calls": len(consulted),
        "model_call_failures": sum(row["on"]["proposal"] is None for row in consulted),
        "latency_ms": {
            "median": statistics.median(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
        },
        "widening_only_violations": [row["id"] for row in rows if not row["widening_only"]],
        "raw_outputs_containing_values": [row["id"] for row in consulted if row.get("values_in_raw_output")],
        "proposals_containing_values": [row["id"] for row in consulted if row.get("values_in_proposal")],
        "adversarial_live_consulted": sum(row["on"]["consulted"] for row in live_adversarial),
        "scripted_mismatches": [item["id"] for item in report["scripted"] if not item["matches_expectation"]],
        "route_failure_fell_back": report["route_failure"]["fell_back"],
    }


def run_end_to_end(data: dict[str, Any], out: Path) -> None:
    base = configured()
    repository = IntelligenceRepository.from_settings(base)

    def build(config: Settings) -> RecruitingAgent:
        interpreter = None
        if config.agent_intent_llm_enabled:
            interpreter = LlmGoalIntentInterpreter(ModelRouter.from_settings(config, tracker=repository).client("classify"))
        return RecruitingAgent(
            RecruitingTools(SupabaseRecruitingKnowledge(repository), readiness_store=SupabaseReadinessPlanStore(repository.client)),
            repository,
            useful_tools=UsefulQuestionTools(SupabasePortfolioQueries(repository.client)),
            intent_interpreter=interpreter,
        )

    modes = (("off", configured(AGENT_INTENT_LLM_ENABLED=False)), ("on", configured(AGENT_INTENT_LLM_ENABLED=True)))
    rows: list[dict[str, Any]] = []
    for group in ("handled", "unhandled", "adversarial_live", "targeted"):
        for item in data.get(group, []):
            row: dict[str, Any] = {"id": item["id"], "group": group, "bucket": item.get("bucket"), "question": item["question"]}
            for mode, config in modes:
                started = time.monotonic()
                events = list(build(config).stream(item["question"]))
                final = next((event for event in reversed(events) if event.type in ("answer_completed", "run_failed")), None)
                state = final.data.get("state") if final is not None and final.type == "answer_completed" else None
                forecast = (state or {}).get("forecast")
                row[mode] = {
                    "status": final.type if final is not None else "no_terminal_event",
                    "tools": [call["tool"] for call in (state or {}).get("tool_calls", [])],
                    "forecast": {key: forecast.get(key) for key in ("expected_opening_date", "interval_start", "interval_end", "confidence")} if forecast else None,
                    "model_provider": final.data.get("model_provider") if final is not None else None,
                    "answer": (final.data.get("answer") or "")[:280] if final is not None and final.type == "answer_completed" else (final.message if final is not None else None),
                    "unresolved": (state or {}).get("unresolved_questions", []),
                    "elapsed_ms": _ms(started),
                }
            both_forecasts = row["off"]["forecast"] is not None and row["on"]["forecast"] is not None
            row["checks"] = {
                "off_reports_no_model": row["off"]["model_provider"] is None,
                "forecast_values_identical": (row["off"]["forecast"] == row["on"]["forecast"]) if both_forecasts else None,
                "handled_tools_identical": (row["off"]["tools"] == row["on"]["tools"]) if (group == "handled" or item.get("bucket") == "handled") else None,
                "handled_reports_no_model": (row["on"]["model_provider"] is None) if (group == "handled" or item.get("bucket") == "handled") else None,
                "answer_values_absent_from_model": not values_in(json.dumps(row["on"].get("model_provider"))),
            }
            rows.append(row)
            print(f"{item['id']} off={len(row['off']['tools'])} tools on={len(row['on']['tools'])} tools provider={row['on']['model_provider']}", file=sys.stderr, flush=True)

    unhandled = [row for row in rows if row["group"] == "unhandled" or row.get("bucket") == "unhandled"]
    summary = {
        "runs_not_completed": [f'{row["id"]}:{mode}' for row in rows for mode in ("off", "on") if row[mode]["status"] != "answer_completed"],
        "forecasts_generated": {mode: sum(row[mode]["forecast"] is not None for row in rows) for mode in ("off", "on")},
        "off_reports_no_model_violations": [row["id"] for row in rows if not row["checks"]["off_reports_no_model"]],
        "forecast_value_differences": [row["id"] for row in rows if row["checks"]["forecast_values_identical"] is False],
        "handled_tool_differences": [row["id"] for row in rows if row["checks"]["handled_tools_identical"] is False],
        "handled_model_reported": [row["id"] for row in rows if row["checks"]["handled_reports_no_model"] is False],
        "unhandled_more_tools_with_model": sum(len(row["on"]["tools"]) > len(row["off"]["tools"]) for row in unhandled),
        "unhandled_forecast_only_with_model": sum(row["on"]["forecast"] is not None and row["off"]["forecast"] is None for row in unhandled),
        "unhandled_added_latency_ms_median": statistics.median(
            [row["on"]["elapsed_ms"] - row["off"]["elapsed_ms"] for row in unhandled]
        ) if unhandled else None,
    }
    report = {"rows": rows, "summary": summary}
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(summary, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("layer", choices=("selection", "end-to-end"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--require-all-fields",
        action="store_true",
        help="Experiment: mark every schema property required before it is sent to the provider.",
    )
    args = parser.parse_args()
    if args.require_all_fields:
        global SCHEMA_CONTRACT
        from firstseen import providers

        production_format = providers._structured_response_format

        def all_required(model: Any) -> dict[str, Any]:
            response_format = production_format(model)
            schema = response_format["json_schema"]["schema"]
            schema["required"] = list(schema.get("properties", {}))
            return response_format

        providers._structured_response_format = all_required
        SCHEMA_CONTRACT = "all_required"
    data = json.loads(QUESTIONS.read_text())
    if args.layer == "selection":
        run_selection(data, args.out)
    else:
        run_end_to_end(data, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
