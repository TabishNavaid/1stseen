import type { ReactNode } from "react";
import Link from "next/link";
import { SkipFirstRunButton } from "@/components/onboarding/skip-first-run-button";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input, Select } from "@/components/ui/input";
import { SEASON_LABELS, SEASON_VALUES, TRACKS, placesText, type OnboardingAnswers } from "@/lib/onboarding";

function Question({ id, number, prompt, hint, children }: { id: string; number: number; prompt: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 grid gap-3 border-0 border-t border-line p-0 pt-6" aria-describedby={`${id}-hint`}>
      <legend className="float-left w-full p-0 text-base font-semibold text-ink">
        <span className="tabular text-ink-subtle">{number}.</span> {prompt}
      </legend>
      <p id={`${id}-hint`} className="clear-both text-caption text-ink-subtle">{hint}</p>
      {children}
    </fieldset>
  );
}

/**
 * The four first-run questions as one GET form, so the answers are a URL and the review step is a server render
 * of exactly those answers. Every question can be left unanswered, which matches every role.
 */
export function WelcomeQuestions({ answers, years, rerun }: { answers: OnboardingAnswers; years: number[]; rerun: boolean }) {
  return (
    <section aria-labelledby="welcome-title">
      <p className="label-caps text-accent-ink">{rerun ? "Your watchlist" : "Welcome to 1stSeen"}</p>
      <h1 id="welcome-title" className="mt-2 text-2xl font-semibold tracking-title md:text-3xl">
        {rerun ? "Update what you are preparing for" : "Four questions, then a watchlist that fits"}
      </h1>
      <p className="mt-4 text-sm leading-6 text-ink-muted">
        Your answers choose a starting set of early-career technical roles to watch. You review the list before anything is saved, and you can
        change it or run these questions again from settings.
      </p>

      <form method="get" action="/welcome" className="mt-8 grid gap-8">
        <input type="hidden" name="step" value="review" />

        <Question id="track" number={1} prompt="What kind of role are you aiming for?" hint="Choose any that apply. Leave all unchecked to include every discipline.">
          <div className="grid gap-x-6 sm:grid-cols-2">
            {TRACKS.map((track) => {
              const id = `track-${track.value}`;
              return (
                <div key={track.value} className="flex min-h-touch items-start gap-2.5">
                  <input type="checkbox" id={id} name="track" value={track.value} defaultChecked={answers.tracks.includes(track.value)} aria-describedby={`${id}-includes`} className="focus-ring mt-3 size-4 shrink-0 accent-accent" />
                  <div className="flex-1 py-2.5">
                    <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-ink">{track.label}</label>
                    <p id={`${id}-includes`} className="mt-0.5 text-caption text-ink-subtle">{track.includes}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </Question>

        <Question id="grad" number={2} prompt="When do you graduate?" hint="This decides between internships, new-grad programs, or both.">
          <label htmlFor="grad-year" className="sr-only">Graduation year</label>
          <Select id="grad-year" name="grad" defaultValue={answers.graduationYear === null ? "" : String(answers.graduationYear)} className="w-full sm:w-64">
            <option value="">Prefer not to say</option>
            {years.map((year) => <option key={year} value={year}>{year}</option>)}
          </Select>
        </Question>

        <Question id="season" number={3} prompt="Which season are you targeting?" hint="Roles that do not state a season are always included.">
          <div className="flex flex-wrap gap-x-6">
            {[["", "Any season"] as const, ...SEASON_VALUES.map((value) => [value, SEASON_LABELS[value]] as const)].map(([value, label]) => {
              const id = `season-${value || "any"}`;
              return (
                <div key={id} className="flex min-h-touch items-center gap-2.5">
                  <input type="radio" id={id} name="season" value={value} defaultChecked={(answers.season ?? "") === value} className="focus-ring size-4 shrink-0 accent-accent" />
                  <label htmlFor={id} className="cursor-pointer text-sm font-medium text-ink">{label}</label>
                </div>
              );
            })}
          </div>
        </Question>

        <Question id="place" number={4} prompt="Where would you work? (optional)" hint="Up to three places, separated by “or”. Roles with no stated location are always included.">
          <label htmlFor="place-input" className="sr-only">Places</label>
          <Input id="place-input" name="place" defaultValue={placesText(answers.places)} placeholder="New York, NY or London" autoComplete="off" className="w-full" />
        </Question>

        {/* Stacked in DOM order on narrow screens, so the visual order and the Tab order agree at every width. */}
        <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-start sm:justify-between">
          {rerun
            ? <Link href="/settings" className="focus-ring inline-flex min-h-touch items-center text-sm font-semibold text-ink-muted hover:text-ink">Back to settings</Link>
            : <SkipFirstRunButton />}
          <Button type="submit">Show my starting watchlist<Icon name="arrow-right" size={15} /></Button>
        </div>
      </form>
    </section>
  );
}
