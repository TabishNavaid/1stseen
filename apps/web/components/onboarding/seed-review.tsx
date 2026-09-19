"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { SkipFirstRunButton } from "@/components/onboarding/skip-first-run-button";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/ui/status";
import { disciplineLabel, programTypeLabel } from "@/lib/dashboard-query";
import { formatDay } from "@/lib/dates";
import { SEASON_LABELS, TRACKS, welcomeHref, type OnboardingAnswers } from "@/lib/onboarding";
import type { SeedResult, SeedRole } from "@/lib/onboarding-data";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function evidenceLine(role: SeedRole): string {
  if (role.currentForecast && role.windowStart && role.windowEnd) {
    const confidence = role.confidence === null ? "" : ` · confidence score ${Math.round(role.confidence)} of 100, from ${plural(role.cycles ?? 0, "cycle")}`;
    return `Forecast window ${formatDay(role.windowStart)} to ${formatDay(role.windowEnd)}${confidence}`;
  }
  const events = [
    role.exactEvents ? `${role.exactEvents} exact` : null,
    role.boundedEvents ? `${role.boundedEvents} bounded` : null,
    role.observedEvents ? `${role.observedEvents} observed-by` : null,
  ].filter(Boolean);
  return `No forecast yet: ${events.length ? `${events.join(", ")} opening ${role.exactEvents + role.boundedEvents + role.observedEvents === 1 ? "date" : "dates"} so far` : "no dated opening so far"}`;
}

function answersSummary(answers: OnboardingAnswers, programTypes: string): string {
  const tracks = TRACKS.filter((track) => answers.tracks.includes(track.value)).map((track) => track.label.toLowerCase());
  const parts = [
    tracks.length ? tracks.join(", ") : "every discipline",
    programTypes,
    answers.season ? `${SEASON_LABELS[answers.season].toLowerCase()} or unstated season` : null,
    answers.places.length ? `${answers.places.join(" or ")}, or no stated location` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

/**
 * The proposed starting watchlist. Everything is checked; unchecking removes a role. Nothing is saved until the
 * user confirms, and confirming follows the checked roles in this order, so the first one with a forecast is where the
 * readiness plan is built and where the user lands.
 */
export function SeedReview({ answers, seeds, programTypes }: { answers: OnboardingAnswers; seeds: SeedResult; programTypes: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(seeds.roles.map((role) => role.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = seeds.roles.filter((role) => selected.has(role.id));
  const planRole = chosen.find((role) => role.currentForecast) ?? null;

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          answers: { tracks: answers.tracks, graduation_year: answers.graduationYear, season: answers.season, places: answers.places },
          role_ids: chosen.map((role) => role.id),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect?: string };
      if (!response.ok || !body.redirect) {
        throw new Error(response.status === 401 ? "Your session has ended. Sign in again, and your answers will still be here." : "Your watchlist was not saved. Try again.");
      }
      router.replace(body.redirect);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your watchlist was not saved. Try again.");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="seed-title">
      <p className="label-caps text-accent-ink">Your starting watchlist</p>
      <h1 id="seed-title" className="mt-2 text-2xl font-semibold tracking-title md:text-3xl">
        {seeds.roles.length ? `Watch these ${plural(seeds.roles.length, "role")}?` : "No role fits all four answers yet"}
      </h1>
      <p className="mt-3 text-sm leading-6 text-ink-muted">
        {plural(seeds.matchingRoles, "in-scope role")} {seeds.matchingRoles === 1 ? "fits" : "fit"} your answers ({answersSummary(answers, programTypes)}), and{" "}
        {plural(seeds.matchingCurrentForecasts, "has a forecast", "have a forecast")}.
        {seeds.roles.length > 0 && " Roles with a forecast are listed first, then the closest matches, with at most two from any company. Low-confidence forecasts are not left out."}
      </p>

      {seeds.roles.length === 0 ? (
        <div className="mt-6 panel">
          <EmptyState
            icon="search"
            headingLevel={2}
            title="Widen one answer to see roles"
            description="A stated season or place leaves out roles that state a different one. Leaving a question unanswered includes every role for it."
            action={
              <div className="flex flex-wrap justify-center gap-4">
                <Link href={welcomeHref(answers)} className="link-accent focus-ring text-sm">Change my answers</Link>
                <Link href="/" className="link-accent focus-ring text-sm">Browse every role</Link>
              </div>
            }
          />
        </div>
      ) : (
        <fieldset className="m-0 mt-6 border-0 p-0">
          <legend className="sr-only">Roles to watch</legend>
          <ul className="panel divide-y divide-line">
            {seeds.roles.map((role) => {
              const id = `seed-${role.id}`;
              const tags = [
                programTypeLabel(role.programType),
                disciplineLabel(role.discipline),
                role.locationMatched ? `Matches ${role.location}` : role.location === "unspecified" ? "Location not stated" : role.location,
                role.seasonMatched ? `${SEASON_LABELS[role.season as keyof typeof SEASON_LABELS] ?? role.season} season` : null,
                role.isFollowed ? "Already watching" : null,
              ].filter(Boolean);
              return (
                <li key={role.id} className="flex items-start gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    id={id}
                    checked={selected.has(role.id)}
                    onChange={(event) => toggle(role.id, event.target.checked)}
                    aria-describedby={`${id}-evidence ${id}-tags`}
                    className="focus-ring mt-1 size-4 shrink-0 accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <label htmlFor={id} className="block cursor-pointer text-sm font-semibold text-ink">
                      {role.company} <span className="font-normal text-ink-muted">· {role.title}</span>
                    </label>
                    <p id={`${id}-evidence`} className={role.currentForecast ? "mt-1 text-caption text-accent-ink" : "mt-1 text-caption text-ink-subtle"}>{evidenceLine(role)}</p>
                    {role.basis && <p className="mt-1"><ForecastBasisChip basis={role.basis} variant="plain" /></p>}
                    <p id={`${id}-tags`} className="mt-0.5 text-micro text-ink-subtle">{tags.join(" · ")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {seeds.roles.length > 0 && (
        <div className="mt-6 grid gap-4">
          <p className="text-caption text-ink-subtle" aria-live="polite">
            {chosen.length === 0
              ? "Nothing is checked. Check at least one role, or skip and browse."
              : planRole
                ? `You will land on ${planRole.company} · ${planRole.title}, the first checked role with a forecast, with its preparation plan built.`
                : "None of the checked roles has a forecast yet, so there is no preparation plan to build. You will land on your watchlist."}
          </p>
          {error && <p role="alert" className="text-sm font-semibold text-danger-ink">{error}</p>}
          {/* Stacked in DOM order on narrow screens, so the visual order and the Tab order agree at every width. */}
          <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-wrap items-start gap-2">
              <Link href={welcomeHref(answers)} className="focus-ring inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch">
                <Icon name="arrow-left" size={15} />Change my answers
              </Link>
              <SkipFirstRunButton />
            </div>
            <Button type="button" onClick={() => void confirm()} disabled={busy || chosen.length === 0} aria-busy={busy}>
              {busy ? <Icon name="loader-circle" size={15} className="animate-spin" /> : <Icon name="bell" size={15} />}
              {busy ? "Saving your watchlist…" : `Watch ${plural(chosen.length, "role")}${planRole ? " and build my plan" : ""}`}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
