import type { ReactNode } from "react";
import Link from "next/link";
import { CountUp } from "@/components/count-up";
import { OpeningSoonCard } from "@/components/landing/opening-soon-card";
import { RolePreviewCard } from "@/components/landing/role-preview-card";
import { StatusLine } from "@/components/landing/status-line";
import { ReturningGuestNote } from "@/components/onboarding/returning-guest-note";
import { Icon } from "@/components/ui/icon";
import { formatShortDay } from "@/lib/dates";
import type { LandingData } from "@/lib/landing-data";
import type { RealOpening } from "@/lib/real-data";
import { sitePage } from "@/lib/site-links";

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

/** Days from today to a window's first day, for the section's heading. */
function daysUntil(windowStart: string, now: Date): number {
  return Math.round((Date.parse(`${windowStart}T12:00:00Z`) - now.getTime()) / 86_400_000);
}

function OpenedCard({ opening, hidden = false }: { opening: RealOpening; hidden?: boolean }) {
  return (
    <li className="card lift relative w-64 shrink-0 p-4" aria-hidden={hidden || undefined}>
      <p className="text-micro font-semibold uppercase tracking-label text-warm-ink">Opened {formatShortDay(opening.openedOn)}</p>
      <p className="mt-2 truncate text-caption font-semibold text-ink-muted">{opening.company}</p>
      <p className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-ink">
        {hidden ? opening.role : (
          <Link href={`/roles/${opening.roleId}`} className="focus-ring rounded-sm after:absolute after:inset-0 after:rounded-card after:content-['']">{opening.role}</Link>
        )}
      </p>
    </li>
  );
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
      <StatusLine status={data?.status ?? null} now={now} />
      <main id="landing-content">
        <section aria-labelledby="hero-title" className="relative overflow-hidden">
          <span className="glow glow-accent -left-40 -top-32 size-[34rem] opacity-60" aria-hidden="true" />
          <span className="glow glow-warm -right-24 top-24 size-[26rem] opacity-70" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-10 md:px-6 md:pt-16 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:gap-16 lg:pb-24">
            <div>
              <h1 id="hero-title" className="rise heading-display text-[2.6rem] leading-[1.05] text-ink sm:text-6xl">
                Know when internships open, <span className="relative whitespace-nowrap text-accent">before<span className="absolute inset-x-0 -bottom-1 h-2 rounded-full bg-warm/60" aria-hidden="true" /></span> everyone else.
              </h1>
              <p className="rise mt-5 max-w-xl text-lg leading-8 text-ink-muted" style={{ animationDelay: "90ms" }}>
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

            {preview && <div className="fade-in relative" style={{ animationDelay: "160ms" }}><RolePreviewCard preview={preview} /></div>}
          </div>
        </section>

        {opened.openings.length > 0 && (
          <section aria-labelledby="opened-title" className="mx-auto max-w-6xl px-4 pb-16 md:px-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="opened-title" className="flex items-center gap-2 text-lg font-semibold text-ink">
                <span className="relative flex size-2.5" aria-hidden="true"><span className="absolute inline-flex size-full animate-ping rounded-full bg-warm opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-warm-line" /></span>
                Just opened
              </h2>
              <Link href="/opened" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                See all <CountUp value={opened.total} /><Icon name="arrow-right" size={14} />
              </Link>
            </div>
            {/* The track holds the programs twice so the drift can loop; the copy is hidden from assistive technology,
                and a keyboard or a pointer stops the drift (globals.css). */}
            <div className="drift-strip edge-fade -mx-4 mt-3 overflow-x-auto px-4 pb-2 md:mx-0 md:overflow-hidden md:px-0">
              <ul className="drift-track flex w-max gap-3" aria-label="Programs that just opened">
                {opened.openings.map((opening) => <OpenedCard key={opening.id} opening={opening} />)}
                {opened.openings.map((opening) => <OpenedCard key={`${opening.id}-again`} opening={opening} hidden />)}
              </ul>
            </div>
          </section>
        )}

        <section id="how" aria-labelledby="how-title" className="border-y border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:px-6 md:py-20">
            <h2 id="how-title" className="heading-display text-3xl leading-tight sm:text-4xl">How it works</h2>
            <div className="max-w-2xl text-base leading-8 text-ink-muted">
              <p>
                1stSeen reads company career pages, the job boards they post on, and archived copies of both, and records
                the day each program appeared. Most programs come back around the same time each year, so those dates
                make a rhythm{preview ? ": the chart above shows one program's, year by year" : ", year by year"}.
              </p>
              <p className="mt-4">
                A statistical model turns that history into the window a program is likely to open in next, with a
                confidence level. Save the ones you care about and their dates go on your watchlist, with a plan that
                works back from each window so your résumé is ready first.
              </p>
              <Link href={sitePage("methodology").href} className="link-accent focus-ring mt-5 inline-flex min-h-touch items-center gap-1 text-sm font-semibold">
                How the forecasts are made<Icon name="arrow-right" size={14} />
              </Link>
            </div>
          </div>
        </section>

        {soon.length > 0 && (
          <section aria-labelledby="soon-title" className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 id="soon-title" className="heading-display text-3xl leading-tight sm:text-4xl">{soonHeading}</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">The next windows, soonest first, one program per company.</p>
              </div>
              <Link href="/roles" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                Browse every program<Icon name="arrow-right" size={14} />
              </Link>
            </div>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {soon.map((role) => <OpeningSoonCard key={role.roleId} role={role} />)}
            </ul>
          </section>
        )}

        <section aria-labelledby="questions-title" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-3xl px-4 py-16 md:px-6 md:py-20">
            <h2 id="questions-title" className="heading-display text-3xl leading-tight sm:text-4xl">Questions</h2>
            <div className="mt-8 divide-y divide-line border-y border-line">
              {QUESTIONS.map((item) => (
                <details key={item.question} className="group py-2">
                  <summary className="focus-ring flex min-h-touch cursor-pointer list-none items-center justify-between gap-4 rounded-control py-3 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden">
                    {item.question}
                    <Icon name="chevron-down" size={18} className="shrink-0 text-ink-subtle transition-transform group-open:rotate-180" />
                  </summary>
                  <p className="pb-4 pr-8 text-sm leading-7 text-ink-muted">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="start-title" className="relative overflow-hidden px-4 py-20 md:px-6 md:py-24">
          <span className="glow glow-accent left-1/2 top-0 size-[30rem] -translate-x-1/2 opacity-70" aria-hidden="true" />
          <span className="glow glow-warm right-10 bottom-0 size-[20rem] opacity-60" aria-hidden="true" />
          <div className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
            <h2 id="start-title" className="heading-display text-3xl leading-tight sm:text-4xl">Start watching the programs you care about</h2>
            <p className="mt-3 max-w-lg text-base leading-7 text-ink-muted">Pick a few, and their likely dates and prep plan are waiting the next time you open 1stSeen.</p>
            <Link href="/welcome" className="press focus-ring mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-7 text-base font-semibold text-ink-inverse shadow-card hover:bg-accent-hover">
              Get started<Icon name="arrow-right" size={17} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
