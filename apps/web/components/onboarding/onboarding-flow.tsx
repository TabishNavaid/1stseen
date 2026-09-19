"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { Icon } from "@/components/ui/icon";
import { Pictogram, type PictogramName } from "@/components/ui/pictogram";
import { Chip } from "@/components/ui/status";
import { REDUCED_MOTION_QUERY, confettiPieces } from "@/lib/celebration";
import { confidenceOutOf } from "@/lib/confidence";
import { formatDay, formatShortDay } from "@/lib/dates";
import { noForecastReason } from "@/lib/forecast-gap";
import {
  GUEST_ONBOARDING_KEY,
  browserStorage,
  clearGuestOnboarding,
  parseGuestOnboarding,
  type GuestOnboarding,
  completeRequest,
  readGuestOnboarding,
  reachedPayoff,
  shouldCarryOver,
  writeGuestOnboarding,
  answering,
} from "@/lib/guest-onboarding";
import {
  FIELDS,
  LOOKING_FOR,
  MAX_COMPANIES,
  ONBOARDING_STEPS,
  answersSummary,
  browseHref,
  hasAnyAnswer,
  welcomeHref,
  type FieldValue,
  type LookingFor,
  type OnboardingAnswers,
} from "@/lib/onboarding";
import type { CompanyChoice, OnboardingPayoff } from "@/lib/onboarding-data";
import { cn } from "@/lib/utils";

type Step = 1 | 2 | 3 | 4;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** " and Acme", " and Acme and Bolt", or " and 3 companies": the followed companies, after the programs. */
function companyPhrase(names: (string | undefined)[]): string {
  if (names.length === 0) return "";
  const known = names.filter((name): name is string => Boolean(name));
  return known.length === names.length && names.length <= 2 ? ` and ${known.join(" and ")}` : ` and ${plural(names.length, "company", "companies")}`;
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the visitor asked for less motion. The server render assumes they did, so nothing moves before hydration. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION_QUERY).matches, () => true);
}

function subscribeStorage(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === GUEST_ONBOARDING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** This browser's stored first-run record, read after hydration; the server render has none. */
function useGuestRecord(): GuestOnboarding | null {
  const raw = useSyncExternalStore(subscribeStorage, () => {
    try {
      return globalThis.localStorage?.getItem(GUEST_ONBOARDING_KEY) ?? null;
    } catch {
      return null;
    }
  }, () => null);
  return useMemo(() => parseGuestOnboarding(raw), [raw]);
}

/** A big selectable card: a native radio or checkbox inside its label, so the whole card is the hit area. */
function ChoiceCard({
  type,
  name,
  value,
  checked,
  onChange,
  pictogram,
  label,
  hint,
  compact = false,
}: {
  type: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  pictogram: PictogramName;
  label: ReactNode;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <label
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-3 rounded-card border-2 bg-surface text-left shadow-raised transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
        compact ? "min-h-16 px-3 py-3" : "min-h-20 px-4 py-4 sm:px-5",
        checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong hover:bg-surface-hover",
      )}
    >
      <input type={type} name={name} value={value} checked={checked} onChange={(event) => onChange(event.target.checked)} className="sr-only" />
      <span className={cn("grid shrink-0 place-items-center rounded-control", compact ? "size-10" : "size-12", checked ? "bg-accent text-ink-inverse" : "bg-surface-sunken text-accent-ink")}>
        <Pictogram name={pictogram} size={compact ? 20 : 24} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block font-semibold text-ink", compact ? "text-sm" : "text-base")}>{label}</span>
        {hint && <span className="mt-0.5 block text-caption leading-5 text-ink-muted">{hint}</span>}
      </span>
      {/* The state is a shape as well as a colour: an empty ring or a filled check; on a small chip, a corner badge. */}
      {compact ? (
        checked && <span className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border-2 border-surface bg-accent text-ink-inverse" aria-hidden="true"><Icon name="check" size={13} strokeWidth={3} /></span>
      ) : (
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border-2", checked ? "border-accent bg-accent text-ink-inverse" : "border-line-strong")} aria-hidden="true">
          {checked && <Icon name="check" size={14} strokeWidth={3} />}
        </span>
      )}
    </label>
  );
}

function Question({ id, title, hint, children, headingRef }: { id: string; title: string; hint: string; children: ReactNode; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  return (
    <fieldset className="step-in m-0 border-0 p-0" aria-describedby={`${id}-hint`}>
      <legend className="p-0">
        <h1 id={id} ref={headingRef} tabIndex={-1} className="heading-display text-3xl leading-tight text-ink outline-none sm:text-4xl">{title}</h1>
      </legend>
      <p id={`${id}-hint`} className="mt-3 text-base leading-7 text-ink-muted">{hint}</p>
      <div className="mt-8">{children}</div>
    </fieldset>
  );
}

function ProgressDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2">
      <p className="sr-only" aria-live="polite">Step {step} of {ONBOARDING_STEPS}</p>
      <ol className="flex items-center gap-2" aria-hidden="true">
        {Array.from({ length: ONBOARDING_STEPS }, (_, index) => (
          <li key={index} className={cn("h-2 rounded-full transition-all", index + 1 === step ? "w-7 bg-accent" : index + 1 < step ? "w-2 bg-accent" : "w-2 bg-line-strong")} />
        ))}
      </ol>
    </div>
  );
}

function Celebration({ reducedMotion }: { reducedMotion: boolean }) {
  const pieces = confettiPieces(reducedMotion);
  const tone = { accent: "bg-accent", warm: "bg-warm", "warm-line": "bg-warm-line", success: "bg-success-line" } as const;
  return (
    <div className="relative mx-auto grid size-20 place-items-center" aria-hidden="true">
      {pieces.length > 0 && (
        <span className="confetti pointer-events-none absolute inset-0">
          {pieces.map((piece, index) => (
            <span
              key={index}
              className={cn("confetti-piece", tone[piece.tone])}
              style={{ ["--confetti-x" as string]: `${piece.x}px`, ["--confetti-y" as string]: `${piece.y}px`, ["--confetti-r" as string]: `${piece.rotate}deg`, animationDelay: `${piece.delay}ms` }}
            />
          ))}
        </span>
      )}
      <span className="pop-in grid size-20 place-items-center rounded-full bg-warm text-ink shadow-card">
        <Icon name="check" size={38} strokeWidth={3} />
      </span>
    </div>
  );
}

function PayoffRoleRow({ role }: { role: OnboardingPayoff["roles"][number] }) {
  return (
    <li className="flex items-start gap-3 rounded-card border border-line bg-surface p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-control bg-accent-soft text-xs font-bold text-accent-ink" aria-hidden="true">
        {role.company.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-caption font-semibold text-ink-muted">
          {role.company}
          {role.atWatchedCompany && <span className="ml-2 inline-flex rounded-chip bg-warm-soft px-2 py-0.5 text-micro font-semibold text-warm-ink">You picked this company</span>}
        </p>
        <p className="mt-0.5 text-sm font-semibold leading-snug text-ink">
          <Link href={`/roles/${role.id}`} className="focus-ring rounded-sm hover:underline">{role.title}</Link>
        </p>
        <p className="mt-0.5 text-caption text-ink-subtle">{[role.programType, role.discipline, role.location].filter(Boolean).join(" · ")}</p>
        {role.window ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-ink-muted">
            <span className="inline-flex rounded-control border border-dashed border-date-predicted-line bg-date-predicted-surface px-2 py-0.5 font-semibold tabular text-date-predicted-ink">
              Predicted {formatShortDay(role.window.start)} – {formatDay(role.window.end)}
            </span>
            <span className="tabular">Confidence {confidenceOutOf(role.window.confidence)}</span>
            {role.window.basis && <ForecastBasisChip basis={role.window.basis} variant="plain" />}
          </p>
        ) : (
          <p className="mt-1.5 text-caption leading-5 text-ink-subtle">No window yet. {noForecastReason(role.openingsRecorded)}</p>
        )}
      </div>
    </li>
  );
}

/**
 * The first run, one question per screen: what you are looking for, which fields, which companies, then the payoff.
 *
 * Steps one to three live in the browser; the payoff is `/welcome?step=ready&…`, a server render of exactly those
 * answers from the same read path as the roles page. "Skip, just browse" is on every screen. A guest's answers are kept
 * in local storage (lib/guest-onboarding.ts); a guest who chooses "Save these" signs up, and the next signed-in visit
 * here saves the answers into the account without asking again. Focus moves to each new question's heading.
 */
export function OnboardingFlow({
  initialAnswers,
  answersInUrl,
  companies,
  popular,
  payoff,
  signedIn,
  autoSave,
  rerun,
}: {
  initialAnswers: OnboardingAnswers;
  /** The URL carried answers, which win over anything stored in the browser. */
  answersInUrl: boolean;
  companies: CompanyChoice[];
  popular: CompanyChoice[];
  /** Present on the payoff step. */
  payoff: OnboardingPayoff | null;
  signedIn: boolean;
  /** Set when a signed-in visit arrived to save a guest's stored answers. */
  autoSave: boolean;
  rerun: boolean;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const stored = useGuestRecord();
  // Until the visitor changes an answer, a guest arriving without answers in the URL sees the ones this browser kept.
  const [edited, setEdited] = useState<OnboardingAnswers | null>(null);
  const answers = edited ?? (!answersInUrl && !signedIn && stored && hasAnyAnswer(stored.answers) ? stored.answers : initialAnswers);
  const setAnswers = (change: (current: OnboardingAnswers) => OnboardingAnswers) => setEdited(change(answers));
  const [localStep, setLocalStep] = useState<1 | 2 | 3>(1);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ redirect: string; watching: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const autoSaveStarted = useRef(false);
  const step: Step = payoff ? 4 : localStep;
  const byId = useMemo(() => new Map(companies.map((company) => [company.id, company])), [companies]);

  // A signed-in visit with answers a guest asked to save goes straight to their payoff, which saves them.
  useEffect(() => {
    const record = readGuestOnboarding(browserStorage());
    if (signedIn && !payoff && shouldCarryOver(record)) router.replace(`${welcomeHref(record.answers, "ready")}&save=1`);
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A guest's answers are kept as they are given, so leaving mid-way loses nothing; reaching the payoff is recorded.
  useEffect(() => {
    if (signedIn) return;
    const storage = browserStorage();
    const previous = readGuestOnboarding(storage);
    if (payoff) {
      if (!previous?.pendingSave) writeGuestOnboarding(storage, reachedPayoff(answers, new Date(), false));
    } else if (edited) {
      writeGuestOnboarding(storage, answering(edited, previous));
    }
    // answers is derived from edited and the stored record, which this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited, payoff, signedIn]);

  // Each new question is announced by moving focus to its heading (not on first arrival, where the page title leads).
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  async function save() {
    if (!payoff) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completeRequest(answers, payoff.roles.map((role) => role.id))),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect?: string; watching?: number };
      if (!response.ok || !body.redirect) {
        throw new Error(response.status === 401 ? "Your session has ended. Sign in again and your picks will still be here." : "Your picks were not saved. Try again.");
      }
      clearGuestOnboarding(browserStorage());
      setSaved({ redirect: body.redirect, watching: body.watching ?? payoff.roles.length });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your picks were not saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // Saving on arrival runs once, after the first paint, and only for answers a guest asked to save.
  useEffect(() => {
    if (!autoSave || !signedIn || !payoff) return;
    const timer = window.setTimeout(() => {
      if (autoSaveStarted.current || !shouldCarryOver(readGuestOnboarding(browserStorage()))) return;
      autoSaveStarted.current = true;
      void save();
    }, 0);
    return () => window.clearTimeout(timer);
    // save() reads the current answers and payoff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, signedIn, payoff]);

  function saveAsGuest() {
    writeGuestOnboarding(browserStorage(), reachedPayoff(answers, new Date(), true));
    router.push(`/signin?mode=sign_up&return_to=${encodeURIComponent("/welcome")}`);
  }

  async function skip() {
    // A signed-in skip is remembered so the offer is not made again; if saving it fails, browsing is still one step away.
    await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "skip" }) }).catch(() => null);
    router.push("/roles");
  }

  function next() {
    if (step === 1) setLocalStep(2);
    else if (step === 2) setLocalStep(3);
    else if (step === 3) startTransition(() => router.push(welcomeHref(answers, "ready")));
  }

  function back() {
    if (step === 4) {
      setLocalStep(3);
      startTransition(() => router.push(welcomeHref(answers)));
    } else if (step > 1) setLocalStep((step - 1) as 1 | 2);
  }

  const setLookingFor = (value: LookingFor) => setAnswers((current) => ({ ...current, lookingFor: value }));
  const toggleField = (value: FieldValue, on: boolean) =>
    setAnswers((current) => ({ ...current, fields: on ? [...new Set([...current.fields, value])] : current.fields.filter((field) => field !== value) }));
  const toggleCompany = (id: string, on: boolean) =>
    setAnswers((current) => ({
      ...current,
      companies: on ? [...new Set([...current.companies, id])].slice(0, MAX_COMPANIES) : current.companies.filter((company) => company !== id),
    }));

  const search = query.trim().toLowerCase();
  const matches = search ? companies.filter((company) => company.name.toLowerCase().includes(search)).slice(0, 8) : [];
  const shownCompanies = search ? matches : popular;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4 md:px-6">
          <BrandMark href={signedIn ? "/roles" : "/"} className="max-sm:[&>span:last-child]:sr-only" />
          <div className="mx-auto"><ProgressDots step={step} /></div>
          {saved ? <span className="w-8" /> : signedIn ? (
            <button type="button" onClick={() => void skip()} className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">
              Skip, just browse
            </button>
          ) : (
            // A guest's skip is a plain link: nothing to save, and it works before any script has loaded.
            <Link href="/roles" className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">
              Skip, just browse
            </Link>
          )}
        </div>
      </header>

      <main id="welcome-content" className="mx-auto w-full max-w-3xl flex-1 px-4 pb-12 pt-8 md:px-6 md:pt-14">
        {step === 1 && (
          <Question key="q1" id="q-looking-for" headingRef={headingRef} title={rerun ? "What are you looking for now?" : "What are you looking for?"} hint="Pick one, or continue to see all three.">
            <div className="grid gap-3" role="radiogroup" aria-labelledby="q-looking-for">
              {LOOKING_FOR.map((option) => (
                <ChoiceCard key={option.value} type="radio" name="looking-for" value={option.value} checked={answers.lookingFor === option.value} onChange={() => setLookingFor(option.value)} pictogram={option.pictogram} label={option.label} hint={option.hint} />
              ))}
            </div>
          </Question>
        )}

        {step === 2 && (
          <Question key="q2" id="q-fields" headingRef={headingRef} title="Which fields?" hint="Choose as many as you like. None means every field.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
              {FIELDS.map((field) => (
                <ChoiceCard
                  key={field.value}
                  compact
                  type="checkbox"
                  name="field"
                  value={field.value}
                  checked={answers.fields.includes(field.value)}
                  onChange={(on) => toggleField(field.value, on)}
                  pictogram={field.pictogram}
                  label={<>{field.label}<span className="sr-only">: {field.name}</span></>}
                />
              ))}
            </div>
          </Question>
        )}

        {step === 3 && (
          <Question key="q3" id="q-companies" headingRef={headingRef} title="Any companies you're watching?" hint="Optional. Their programs go to the top of your list.">
            <label htmlFor="company-search" className="text-sm font-semibold text-ink">Search companies</label>
            <div className="relative mt-2">
              <Icon name="search" size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input
                id="company-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
                placeholder="Type a company name"
                autoComplete="off"
                aria-describedby="company-results-label"
                className="h-12 w-full rounded-chip border border-line-strong bg-surface pl-11 pr-4 text-base text-ink placeholder:text-ink-subtle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
              />
            </div>
            {answers.companies.length > 0 && (
              <div role="group" aria-label="Companies you picked" className="mt-4 flex flex-wrap gap-2">
                {answers.companies.map((id) => {
                  const name = byId.get(id)?.name ?? "A company";
                  return <Chip key={id} label={name} onRemove={() => toggleCompany(id, false)} className="h-9 border-accent bg-accent-soft text-sm" />;
                })}
              </div>
            )}
            <fieldset className="m-0 mt-6 border-0 p-0">
              <legend id="company-results-label" className="label-caps p-0 text-ink-subtle" aria-live="polite">
                {search ? (matches.length ? `${plural(matches.length, "match", "matches")}` : "No company matches") : "Most programs tracked"}
              </legend>
              {shownCompanies.length > 0 && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {shownCompanies.map((company) => {
                    const checked = answers.companies.includes(company.id);
                    const full = !checked && answers.companies.length >= MAX_COMPANIES;
                    return (
                      <label key={company.id} className={cn("flex min-h-touch cursor-pointer items-center gap-3 rounded-card border-2 bg-surface px-4 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus", checked ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong", full && "cursor-not-allowed opacity-60")}>
                        <input type="checkbox" className="sr-only" checked={checked} disabled={full} onChange={(event) => toggleCompany(company.id, event.target.checked)} />
                        <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border-2", checked ? "border-accent bg-accent text-ink-inverse" : "border-line-strong")} aria-hidden="true">
                          {checked && <Icon name="check" size={14} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-ink">{company.name}</span>
                          <span className="block text-caption text-ink-subtle">{plural(company.roles, "program")} tracked</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          </Question>
        )}

        {step === 4 && payoff && (
          <section aria-labelledby="payoff-title" className="step-in">
            <div className="grid justify-items-center text-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a small self-hosted SVG, which the image optimizer skips */}
              {payoff.matchingRoles > 0 ? <Celebration reducedMotion={reducedMotion} /> : <img src="/illustrations/reading-side.svg" alt="" width={978} height={615} className="w-56" />}
              <h1 id="payoff-title" ref={headingRef} tabIndex={-1} className="heading-display mt-6 text-3xl leading-tight text-ink outline-none sm:text-4xl">
                {saved
                  ? `Saved. You're watching ${plural(saved.watching, "program")}${companyPhrase(answers.companies.map((id) => byId.get(id)?.name))}.`
                  : payoff.matchingRoles > 0
                    ? `Here are ${plural(payoff.matchingRoles, "program")} to watch`
                    : "Nothing fits all of that yet"}
              </h1>
              <p className="mt-3 max-w-xl text-base leading-7 text-ink-muted">
                {payoff.matchingRoles > 0
                  ? <>{answersSummary(answers, (id) => byId.get(id)?.name)}. {plural(payoff.matchingForecasts, "has a predicted window", "have a predicted window")} so far.</>
                  : "Try fewer fields or another program type. Leaving a question blank includes everything for it."}
              </p>
            </div>

            {payoff.roles.length > 0 && (
              <>
                <h2 className="mt-10 label-caps text-ink-subtle">{payoff.matchingRoles > payoff.roles.length ? `The first ${payoff.roles.length}, soonest window first` : "Soonest window first"}</h2>
                <ul className="mt-3 grid gap-3">
                  {payoff.roles.map((role) => <PayoffRoleRow key={role.id} role={role} />)}
                </ul>
              </>
            )}

            {error && <p role="alert" className="mt-6 rounded-control border border-danger-line bg-danger-surface px-4 py-3 text-sm font-semibold text-danger-ink">{error}</p>}
            {saving && <p role="status" className="mt-6 flex items-center justify-center gap-2 text-sm text-ink-muted"><Icon name="loader-circle" size={16} className="animate-spin" />Saving your picks…</p>}
          </section>
        )}
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-col-reverse gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-6">
          {step > 1 && !saved ? (
            <button type="button" onClick={back} className="focus-ring inline-flex min-h-touch items-center justify-center gap-2 rounded-chip px-4 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">
              <Icon name="arrow-left" size={16} />Back
            </button>
          ) : <span />}

          {step < 4 && (
            <button type="button" onClick={next} disabled={pending} aria-busy={pending} className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-7 text-base font-semibold text-ink-inverse hover:bg-accent-hover disabled:opacity-70">
              {pending ? <><Icon name="loader-circle" size={17} className="animate-spin" />Finding your programs…</> : step === 3 ? <>Show my programs<Icon name="arrow-right" size={17} /></> : <>Continue<Icon name="arrow-right" size={17} /></>}
            </button>
          )}

          {step === 4 && payoff && !saved && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Link href={payoff.matchingRoles > 0 ? browseHref(answers) : "/roles"} className="focus-ring inline-flex min-h-touch items-center justify-center rounded-chip border border-line-strong bg-surface px-5 text-sm font-semibold text-ink hover:bg-surface-hover">
                {signedIn ? "Keep browsing" : "Keep browsing as guest"}
              </Link>
              {payoff.roles.length > 0 && (
                signedIn ? (
                  <button type="button" onClick={() => void save()} disabled={saving} aria-busy={saving} className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-6 text-base font-semibold text-ink-inverse hover:bg-accent-hover disabled:opacity-70">
                    <Icon name="bell-ring" size={17} />Watch these and get alerts
                  </button>
                ) : (
                  <button type="button" onClick={saveAsGuest} className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-6 text-base font-semibold text-ink-inverse hover:bg-accent-hover">
                    <Icon name="bell-ring" size={17} />Save these and get alerts
                  </button>
                )
              )}
            </div>
          )}

          {saved && (
            <Link href={saved.redirect} className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-7 text-base font-semibold text-ink-inverse hover:bg-accent-hover sm:ml-auto">
              Open your watchlist<Icon name="arrow-right" size={17} />
            </Link>
          )}
        </div>
        {step === 4 && payoff && !saved && !signedIn && payoff.roles.length > 0 && (
          <p className="mx-auto max-w-3xl px-4 pb-3 text-center text-caption text-ink-subtle sm:text-right md:px-6">A free account keeps these on your watchlist and calendar. Your picks come with you.</p>
        )}
      </footer>
    </div>
  );
}
