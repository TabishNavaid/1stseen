"use client";

import { useState, type FormEvent } from "react";
import { AgentAnswer } from "@/components/agent/agent-answer";
import { useAgentQuestion } from "@/components/agent/use-agent-question";
import { Icon } from "@/components/ui/icon";

// Questions the agent's own question types cover (upcoming openings, the earliest companies, what to prepare now).
const SUGGESTIONS = [
  "Which software engineering internships are likely to open next?",
  "Which companies open their internships earliest?",
  "What should I prepare before new-grad applications open?",
];

/** A question box for anyone: ask about programs, openings, and dates, and see the answer with every step behind it. */
export function AskPanel({ signedIn, guestLimit }: { signedIn: boolean; guestLimit: number }) {
  const run = useAgentQuestion();
  const [question, setQuestion] = useState("");
  const busy = run.status === "running";

  function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 3 || busy) return;
    setQuestion(trimmed);
    void run.ask({ question: trimmed });
  }

  return (
    <div className="grid gap-6">
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit(question);
        }}
        className="card p-3 sm:p-4"
      >
        <label htmlFor="ask-question" className="sr-only">Your question</label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit(question);
            }
          }}
          rows={3}
          maxLength={2000}
          placeholder="When does a program open, what opened recently, how sure is a date…"
          className="block w-full resize-none rounded-control border-0 bg-transparent px-2 py-2 text-base text-ink placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-focus"
        />
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-3">
          <p className="min-w-0 px-2 text-caption text-ink-subtle">{signedIn ? "Answers come from the openings and forecasts on this site." : `Without an account you can ask ${guestLimit} questions a minute.`}</p>
          <button type="submit" disabled={busy || question.trim().length < 3} className="focus-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-chip bg-accent px-5 text-sm font-semibold text-ink-inverse hover:bg-accent-hover disabled:opacity-60">
            {busy ? <Icon name="loader-circle" size={16} className="animate-spin" /> : <Icon name="send-horizontal" size={16} />}
            Ask
          </button>
        </div>
      </form>

      {run.status === "idle" && (
        <div>
          <p className="label-caps text-ink-subtle">Try one</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" onClick={() => submit(suggestion)} className="focus-ring inline-flex min-h-touch items-center rounded-card border border-line-strong bg-surface px-4 py-2 text-left text-sm text-ink hover:bg-surface-hover">
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.status !== "idle" && <div aria-live="polite"><AgentAnswer run={run} /></div>}
    </div>
  );
}
