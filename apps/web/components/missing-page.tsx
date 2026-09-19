import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

/**
 * The not-found page, in two forms: a page that does not exist, and a program 1stSeen no longer tracks (with a link to
 * the company's other programs when the company is known). Both keep a visitor moving: a search that goes to Explore,
 * and three places to go instead.
 *
 * The `data-page-status` attribute is how the Worker entry answers 404 (cloudflare/page-status.ts): the page shell has
 * already been sent by the time this renders, so the page cannot set its own status.
 */
export function MissingPage({ variant = "page", company = null }: { variant?: "page" | "program"; company?: { id: string; name: string } | null }) {
  const program = variant === "program";
  return (
    <main id="missing-content" className="flex-1 bg-canvas" data-page-status="404">
      <section className="mx-auto grid max-w-5xl items-center gap-10 px-4 py-12 md:grid-cols-[minmax(0,1fr)_260px] md:gap-14 md:px-6 md:py-20" aria-labelledby="missing-title">
        <div className="min-w-0">
          <p className="label-caps text-accent-ink">{program ? "Program not found" : "Page not found"}</p>
          <h1 id="missing-title" className="heading-display mt-3 text-4xl leading-tight text-ink sm:text-5xl">
            {program ? "This program is no longer tracked." : "This page hasn’t opened yet."}
          </h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-ink-muted">
            {program
              ? "It may have closed, changed its name, or moved outside the early-career roles 1stSeen follows."
              : "We’ve checked every cycle. No sign of it."}
          </p>
          {program && company && (
            <Link href={`/roles?company=${company.id}`} className="link-accent focus-ring mt-4 inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold">
              See the other programs at {company.name}<Icon name="arrow-right" size={15} />
            </Link>
          )}

          <form action="/roles" method="get" role="search" className="card mt-8 flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
            <label htmlFor="missing-search" className="sr-only">Search companies, roles, or places</label>
            <div className="relative min-w-0 flex-1">
              <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <Input id="missing-search" type="search" name="q" placeholder="Search companies, roles, or places" className="h-11 rounded-chip pl-10 text-sm max-sm:h-touch" />
            </div>
            <button type="submit" className="focus-ring inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-chip bg-accent px-5 text-sm font-semibold text-ink-inverse hover:bg-accent-hover max-sm:h-touch">
              Search
            </button>
          </form>

          <nav aria-label="Where to go instead" className="mt-6">
            <ul className="flex flex-wrap gap-2">
              {[
                { href: "/roles", label: "Explore roles", icon: "radar" as const },
                { href: "/opened", label: "Just opened", icon: "door-open" as const },
                { href: "/", label: "Home", icon: "arrow-left" as const },
              ].map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="focus-ring inline-flex min-h-touch items-center gap-2 rounded-chip border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-hover">
                    <Icon name={item.icon} size={15} />{item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <CalendarQuestion />
      </section>
    </main>
  );
}

/** A calendar page with a question mark where the date should be. Decorative; the mark bobs unless motion is reduced. */
function CalendarQuestion() {
  const days = Array.from({ length: 12 }, (_, index) => ({ x: 58 + (index % 4) * 38, y: 126 + Math.floor(index / 4) * 30 }));
  return (
    <svg viewBox="0 0 260 260" className="mx-auto w-44 md:w-full" aria-hidden="true" focusable="false">
      <ellipse cx="130" cy="238" rx="84" ry="9" className="fill-line" />
      <rect x="34" y="44" width="192" height="176" rx="22" className="fill-surface stroke-line-strong" strokeWidth="2" />
      <path d="M34 66a22 22 0 0 1 22-22h148a22 22 0 0 1 22 22v30H34z" className="fill-accent" />
      <rect x="78" y="30" width="12" height="30" rx="6" className="fill-ink" />
      <rect x="170" y="30" width="12" height="30" rx="6" className="fill-ink" />
      {days.map((day) => (
        <rect key={`${day.x}-${day.y}`} x={day.x} y={day.y} width="20" height="14" rx="4" className="fill-surface-sunken" />
      ))}
      <g className="bob">
        <circle cx="186" cy="196" r="34" className="fill-warm stroke-surface" strokeWidth="5" />
        <path d="M175 186c0-7 5-12 12-12s12 5 12 11c0 8-9 9-9 16" fill="none" className="stroke-ink" strokeWidth="5" strokeLinecap="round" />
        <circle cx="189" cy="212" r="3.5" className="fill-ink" />
      </g>
    </svg>
  );
}
