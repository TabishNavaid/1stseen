import type { ReactNode } from "react";
import Link from "next/link";
import { OpeningSoonCard } from "@/components/landing/opening-soon-card";
import { RolePreviewCard } from "@/components/landing/role-preview-card";
import { ReturningGuestNote } from "@/components/onboarding/returning-guest-note";
import { Icon, type IconName } from "@/components/ui/icon";
import { formatShortDay } from "@/lib/dates";
import type { LandingData } from "@/lib/landing-data";
import { sitePage } from "@/lib/site-links";

const STEPS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "binoculars",
    title: "We watch career pages and job boards",
    body: "1stSeen keeps checking company career sites, the job boards they post on, and old snapshots of both, and records the date each program appears.",
  },
  {
    icon: "calendar-sync",
    title: "We learn each program's yearly rhythm",
    body: "Most programs open around the same time every year. From the dates on record, a statistical model estimates when each one is likely to open next.",
  },
  {
    icon: "bell-ring",
    title: "You know before it opens",
    body: "Save the programs you care about. Their likely dates and a prep plan go on your watchlist and calendar, so your résumé is ready before the rush.",
  },
];

/** Days from today to a window's first day, for the section's heading. */
function daysUntil(windowStart: string, now: Date): number {
  return Math.round((Date.parse(`${windowStart}T12:00:00Z`) - now.getTime()) / 86_400_000);
}

/**
 * The front door for a first-time visitor: one idea per section. What 1stSeen does, on a real program; how it works in
 * three plain steps; the next real windows; and one line on where the dates come from, with the detail on the
 * methodology page. Nothing here is a dashboard, and nothing is shown that the data cannot back: without a preview role
 * the card gives way to the illustration, and without a current window "Opening soon" is left out.
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
      <main id="landing-content">
        <section aria-labelledby="hero-title" className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-8 md:px-6 md:pt-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16 lg:pb-24">
          <div>
            <p className="inline-flex items-center gap-2 rounded-chip border border-warm-line bg-warm-soft px-3 py-1 text-caption font-semibold text-warm-ink">
              <Icon name="sparkles" size={13} />Internships · New grad · Co-ops
            </p>
            <h1 id="hero-title" className="heading-display mt-5 text-[2.6rem] leading-[1.05] text-ink sm:text-6xl">
              Know when internships open, <span className="relative whitespace-nowrap text-accent">before<span className="absolute inset-x-0 -bottom-1 h-2 rounded-full bg-warm/60" aria-hidden="true" /></span> everyone else.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-ink-muted">
              1stSeen learns when each program opens every year and shows you when it is likely to open next.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link href="/welcome" className="focus-ring inline-flex h-12 items-center justify-center gap-2 rounded-chip bg-accent px-6 text-base font-semibold text-ink-inverse shadow-card hover:bg-accent-hover">
                Get started<Icon name="arrow-right" size={17} />
              </Link>
              <Link href="/roles" className="focus-ring inline-flex h-12 items-center justify-center rounded-chip border border-line-strong bg-surface px-6 text-base font-semibold text-ink hover:bg-surface-hover">
                Just browse
              </Link>
            </div>
            <p className="mt-4 text-caption text-ink-subtle">Free to browse, no account needed. Getting started takes about 30 seconds.</p>
            <ReturningGuestNote />
          </div>

          <div className="relative">
            {/* The illustration sits behind the card on a wide screen and above it on a phone. Decorative. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- a small self-hosted SVG, which the image optimizer skips */}
            <img
              src="/illustrations/sprinting.svg"
              alt=""
              width={981}
              height={646}
              className={preview ? "mx-auto -mb-6 w-56 sm:w-64 lg:absolute lg:-top-2 lg:right-2 lg:mb-0 lg:w-56" : "mx-auto w-full max-w-md"}
            />
            {preview && <div className="relative lg:mt-32"><RolePreviewCard preview={preview} /></div>}
          </div>
        </section>

        {opened.openings.length > 0 && (
          <section aria-labelledby="opened-title" className="mx-auto max-w-6xl px-4 pb-14 md:px-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="opened-title" className="flex items-center gap-2 text-lg font-semibold text-ink">
                <span className="relative flex size-2.5" aria-hidden="true"><span className="absolute inline-flex size-full animate-ping rounded-full bg-warm opacity-60" /><span className="relative inline-flex size-2.5 rounded-full bg-warm-line" /></span>
                Just opened
              </h2>
              <Link href="/opened" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                See all {opened.total.toLocaleString("en-US")}<Icon name="arrow-right" size={14} />
              </Link>
            </div>
            <ul className="-mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0" aria-label="Programs that just opened">
              {opened.openings.map((opening) => (
                <li key={opening.id} className="card lift relative w-64 shrink-0 snap-start p-4">
                  <p className="text-micro font-semibold uppercase tracking-label text-warm-ink">Opened {formatShortDay(opening.openedOn)}</p>
                  <p className="mt-2 truncate text-caption font-semibold text-ink-muted">{opening.company}</p>
                  <p className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-ink">
                    <Link href={`/roles/${opening.roleId}`} className="focus-ring rounded-sm after:absolute after:inset-0 after:rounded-card after:content-['']">{opening.role}</Link>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section id="how" aria-labelledby="how-title" className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
            <p className="label-caps text-accent-ink">How it works</p>
            <h2 id="how-title" className="heading-display mt-2 max-w-2xl text-3xl leading-tight sm:text-4xl">Three steps between you and day one</h2>
            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-card border border-line bg-canvas p-6">
                  <span className="flex items-center gap-3">
                    <span className={`grid size-12 place-items-center rounded-card ${index === 2 ? "bg-warm-soft text-warm-ink" : "bg-accent-soft text-accent-ink"}`}>
                      <Icon name={step.icon} size={24} />
                    </span>
                    <span className="text-caption font-semibold tabular text-ink-subtle">Step {index + 1}</span>
                  </span>
                  <h3 className="mt-5 text-lg font-semibold leading-snug text-ink">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-ink-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {soon.length > 0 && (
          <section aria-labelledby="soon-title" className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="label-caps text-accent-ink">Real forecasts</p>
                <h2 id="soon-title" className="heading-display mt-2 text-3xl leading-tight sm:text-4xl">{soonHeading}</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">The next predicted windows, soonest first, one program per company.</p>
              </div>
              <Link href="/roles" className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 text-sm">
                Browse every role<Icon name="arrow-right" size={14} />
              </Link>
            </div>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {soon.map((role) => <OpeningSoonCard key={role.roleId} role={role} />)}
            </ul>
          </section>
        )}

        <section aria-labelledby="trust-title" className={soon.length > 0 ? "px-4 pb-20 md:px-6" : "px-4 py-16 md:px-6 md:py-20"}>
          <div className="mx-auto flex max-w-3xl flex-col items-center rounded-card bg-accent px-6 py-10 text-center text-ink-inverse sm:px-10">
            <span className="grid size-12 place-items-center rounded-full bg-warm text-ink" aria-hidden="true"><Icon name="link-2" size={22} /></span>
            <h2 id="trust-title" className="heading-display mt-4 text-2xl leading-snug sm:text-3xl">Every date links to where we saw it.</h2>
            <Link href={sitePage("methodology").href} className="focus-ring mt-4 inline-flex min-h-touch items-center gap-1 rounded-chip px-2 text-sm font-semibold text-ink-inverse underline decoration-warm decoration-2 underline-offset-4 hover:decoration-ink-inverse">
              How forecasts are made<Icon name="arrow-right" size={14} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
