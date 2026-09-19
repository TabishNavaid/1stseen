import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { OpeningSoonCard } from "@/components/landing/opening-soon-card";
import { RolePreviewCard } from "@/components/landing/role-preview-card";
import { ReturningGuestNote } from "@/components/onboarding/returning-guest-note";
import { Icon } from "@/components/ui/icon";
import { Pictogram, type PictogramName } from "@/components/ui/pictogram";
import type { LandingData } from "@/lib/landing-data";
import { sitePage } from "@/lib/site-links";

const STEPS: ReadonlyArray<{ icon: PictogramName; title: string; body: string }> = [
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
    title: "You get a heads-up before it opens",
    body: "Watch the programs you care about. Their predicted windows and a prep plan land on your calendar, so your résumé is ready before the rush.",
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
export function LandingPage({ data, now = new Date() }: { data: LandingData | null; now?: Date }) {
  const preview = data?.preview ?? null;
  const soon = data?.openingSoon ?? [];
  // "Soon" only when it is: a first window three months or more away is "next", not "soon".
  const soonHeading = soon.length > 0 && daysUntil(soon[0].forecast.windowStart, now) <= 90 ? "Opening soon" : "Next to open";

  return (
    <div className="flex-1 bg-canvas text-ink">
      <a href="#landing-content" className="sr-only z-[60] rounded-control bg-surface px-3 py-2 text-xs font-semibold text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-focus">Skip to content</a>
      <header className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 md:px-6">
        <BrandMark />
        <nav aria-label="Primary" className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link href="/roles" className="focus-ring hidden h-10 items-center rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink sm:inline-flex">Browse roles</Link>
          <Link href="/signin" className="focus-ring inline-flex min-h-touch items-center rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">Sign in</Link>
        </nav>
      </header>

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
              1stSeen learns when each program opens every year and gives you a heads-up before it does.
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

        <section id="how" aria-labelledby="how-title" className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
            <p className="label-caps text-accent-ink">How it works</p>
            <h2 id="how-title" className="heading-display mt-2 max-w-2xl text-3xl leading-tight sm:text-4xl">Three steps between you and day one</h2>
            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-card border border-line bg-canvas p-6">
                  <span className="flex items-center gap-3">
                    <span className={`grid size-12 place-items-center rounded-card ${index === 2 ? "bg-warm-soft text-warm-ink" : "bg-accent-soft text-accent-ink"}`}>
                      <Pictogram name={step.icon} size={24} />
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
            <span className="grid size-12 place-items-center rounded-full bg-warm text-ink" aria-hidden="true"><Pictogram name="link-2" size={22} /></span>
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
