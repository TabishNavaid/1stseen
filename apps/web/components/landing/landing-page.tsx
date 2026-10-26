import type { ReactNode } from "react";
import Link from "next/link";
import { CountUp } from "@/components/count-up";
import { HandMark } from "@/components/brand/hand-mark";
import { Doodle } from "@/components/doodle";
import { JustOpenedList } from "@/components/landing/just-opened-list";
import { LandingMotion } from "@/components/landing/landing-motion";
import { OpeningSoonRows } from "@/components/landing/opening-soon-rows";
import { RolePreviewCard } from "@/components/landing/role-preview-card";
import { StatusLine } from "@/components/landing/status-line";
import { ReturningGuestNote } from "@/components/onboarding/returning-guest-note";
import { Icon } from "@/components/ui/icon";
import { todayIso } from "@/lib/dates";
import type { LandingData } from "@/lib/landing-data";
import { sitePage } from "@/lib/site-links";
import { cn } from "@/lib/utils";

/** What people ask before they sign up. Answers are short and point at the methodology page for the detail. */
const QUESTIONS: ReadonlyArray<{ question: string; answer: ReactNode }> = [
  {
    question: "Is it free?",
    answer: <>Yes. Browsing every program and its dates needs no account, and an account costs nothing.</>,
  },
  {
    question: "Where do the dates come from?",
    answer: <>Company career pages, the job boards they post on, and archived copies of both. Every date on the site links to the page it was seen on.</>,
  },
  {
    question: "How accurate is it?",
    answer: (
      <>
        Each date is a prediction with a window around it and a confidence level, from a statistical model that only
        reads dates already on record. The accuracy is not validated yet, and{" "}
        <Link href={sitePage("methodology").href} className="link-accent focus-ring">the methodology page</Link> says where it stands.
      </>
    ),
  },
  {
    question: "Do I need an account?",
    answer: <>Only to save programs. A watchlist keeps their dates, a prep plan, and a calendar in one place.</>,
  },
  {
    question: "Which companies are covered?",
    answer: <>Companies that run early-career technical programs and post them publicly. The list grows as more are added; Explore shows every one being followed.</>,
  },
];

/**
 * How it works, in three steps, each on its own colour. The blocks are the page changing temperature as it goes
 * down: butter, sage, coral, all light enough to leave every ink on them legible (tests/design-tokens.test.mjs).
 */
const HOW: ReadonlyArray<{ title: string; body: string; block: string }> = [
  {
    title: "We read the career pages",
    body: "Company career pages, the job boards they post on, and archived copies of both. Every opening is recorded with the day it appeared and a link to where it was seen.",
    block: "bg-butter",
  },
  {
    title: "We learn each program's rhythm",
    body: "Most programs come back around the same time each year. A statistical model turns those dates into the window the next one is likely to open in, with a confidence level.",
    block: "bg-sage",
  },
  {
    title: "You get a head start",
    body: "Save the programs you care about and their dates go on your watchlist, with a plan that works back from each window so your résumé is ready first.",
    block: "bg-warm-soft",
  },
];

/** Days from today to a window's first day, for the section's heading. */
function daysUntil(windowStart: string, now: Date): number {
  return Math.round((Date.parse(`${windowStart}T12:00:00Z`) - now.getTime()) / 86_400_000);
}

/**
 * The front door for a first-time visitor: what the product knows, on one program; what opened in the last days; how it
 * works; the windows coming up; the questions people ask; and one way in. Nothing is shown that the data cannot back:
 * without a preview program there is no hero card, without a current window there is no "Opening soon", and the status
 * line under the header appears only while collection is fresh.
 */
export function LandingPage({ data, header, now = new Date() }: { data: LandingData | null; header: ReactNode; now?: Date }) {
  const preview = data?.preview ?? null;
  const soon = data?.openingSoon ?? [];
  const opened = data?.justOpened ?? { openings: [], total: 0 };
  // "Soon" only when it is: a first window three months or more away is "next", not "soon".
  const soonHeading = soon.length > 0 && daysUntil(soon[0].forecast.windowStart, now) <= 90 ? "Opening soon" : "Next to open";

  return (
    <div className="flex-1 bg-canvas text-ink">
      {header}
      {/* The only route that loads an animation library, and only when motion is wanted (landing-motion.tsx). */}
      <LandingMotion />
      <StatusLine status={data?.status ?? null} now={now} />
      <main id="landing-content">
        <section aria-labelledby="hero-title">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 md:px-6 md:pt-16 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:gap-16 lg:pb-24">
            <div>
              <h1 id="hero-title" className="rise heading-display text-[2.6rem] leading-[1.05] text-ink sm:text-6xl">
                Know when internships open, <span className="relative whitespace-nowrap text-accent-ink">before<span className="absolute inset-x-0 -bottom-1 h-2 rounded-full bg-warm/60" aria-hidden="true" /></span> everyone else.
              </h1>
              <p className="rise mt-6 max-w-measure text-lg leading-8 text-ink-muted" style={{ animationDelay: "90ms" }}>
                1stSeen learns when each program opens every year and shows you the window it is likely to open in next.
              </p>
              <div className="rise mt-8 flex flex-col gap-3 sm:flex-row sm:items-center" style={{ animationDelay: "180ms" }}>
                <Link href="/welcome" className="press focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-6 text-base font-semibold text-ink-inverse shadow-card hover:bg-accent-hover">
                  Get started<Icon name="arrow-right" size={17} />
                </Link>
                <Link href="/roles" className="press focus-ring inline-flex h-12 items-center justify-center rounded-chip border border-line-strong bg-surface px-6 text-base font-semibold text-ink hover:bg-surface-hover">
                  Browse programs
                </Link>
              </div>
              <p className="rise mt-4 text-caption text-ink-subtle" style={{ animationDelay: "250ms" }}>Browsing needs no account. Setting up takes about 30 seconds.</p>
              <ReturningGuestNote />
            </div>

            {preview && <div className="fade-in" style={{ animationDelay: "160ms" }}><RolePreviewCard preview={preview} today={todayIso(now)} /></div>}
          </div>
        </section>

        {opened.openings.length > 0 && (
          <section aria-labelledby="opened-title" className="mx-auto max-w-6xl px-4 pb-16 md:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4 pb-8">
              <h2 id="opened-title" className="flex items-center gap-2 text-lg font-semibold text-ink">
                <span className="relative flex size-2.5" aria-hidden="true"><span className="absolute inline-flex size-full animate-ping rounded-full bg-warm opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-warm-line" /></span>
                Just opened
              </h2>
              <Link href="/opened" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                See all <CountUp value={opened.total} /><Icon name="arrow-right" size={14} />
              </Link>
            </div>
            <JustOpenedList openings={opened.openings} now={now} />
          </section>
        )}

        <section id="how" aria-labelledby="how-title" data-reveal className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-24 md:px-6">
            <div className="grid gap-8 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div>
                <h2 id="how-title" className="heading-display text-3xl leading-tight sm:text-4xl">How it works</h2>
                <p className="mt-8 max-w-measure text-base leading-7 text-ink-muted">
                  Three steps between a program going up on a company&rsquo;s site and you knowing it is about to.
                </p>
                {/* Reading the pages, one year at a time: the work the three steps beside this describe. */}
                <Doodle name="sittingReading" size="hero" hideOnPhone className="mt-8" />
              </div>
              <ol className="m-0 grid list-none gap-4 p-0">
                {HOW.map((step, index) => (
                  <li key={step.title} className={cn("rounded-card p-6", step.block)}>
                    <p className="hand text-3xl leading-none text-warm-ink" aria-hidden="true">{index + 1}.</p>
                    <h3 className="heading-display mt-2 text-xl leading-snug text-ink">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-ink-muted">{step.body}</p>
                  </li>
                ))}
              </ol>
            </div>
            <Link href={sitePage("methodology").href} className="link-accent focus-ring mt-8 inline-flex min-h-touch items-center gap-1 text-sm font-semibold">
              How the forecasts are made<Icon name="arrow-right" size={14} />
            </Link>
          </div>
        </section>

        {soon.length > 0 && (
          <section data-reveal aria-labelledby="soon-title" className="mx-auto max-w-6xl px-4 py-24 md:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 id="soon-title" className="heading-display text-3xl leading-tight sm:text-4xl">{soonHeading}</h2>
                <p className="mt-8 max-w-measure text-sm leading-6 text-ink-muted">Every bar is drawn on one scale, so reading down the column shows which window comes first and how much wider one is than another.</p>
              </div>
              <Link href="/roles" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                Browse every program<Icon name="arrow-right" size={14} />
              </Link>
            </div>
            <OpeningSoonRows roles={soon} today={todayIso(now)} />
          </section>
        )}

        {/* One drawn rule where the page turns from what it has to what it asks. */}
        <div aria-hidden="true" className="mx-auto flex max-w-6xl justify-center px-4 md:px-6">
          <HandMark name="divider" className="h-4 w-full max-w-md text-line-strong" />
        </div>

        <section data-reveal aria-labelledby="questions-title" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-3xl px-4 py-24 md:px-6">
            <h2 id="questions-title" className="heading-display text-3xl leading-tight sm:text-4xl">Questions</h2>
            <div className="mt-8 divide-y divide-line border-y border-line">
              {QUESTIONS.map((item) => (
                <details key={item.question} className="group py-2">
                  <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-4 rounded-control py-3 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {item.question}
                    <Icon name="chevron-down" size={18} className="shrink-0 text-ink-subtle transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="max-w-measure pb-4 pr-8 text-sm leading-7 text-ink-muted">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section data-reveal aria-labelledby="start-title" className="px-4 py-24 md:px-6">
          <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
            {/* Off at a run: the page ends where watching starts. */}
            <Doodle name="sprinting" size="hero" className="mb-6 max-sm:h-40" />
            <h2 id="start-title" className="heading-display text-3xl leading-tight sm:text-4xl">Start watching the programs you care about</h2>
            <p className="mt-8 max-w-measure text-base leading-7 text-ink-muted">Pick a few, and their likely dates and prep plan are waiting the next time you open 1stSeen.</p>
            <Link href="/welcome" className="press focus-ring mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-6 text-base font-semibold text-ink-inverse shadow-card hover:bg-accent-hover">
              Get started<Icon name="arrow-right" size={17} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
