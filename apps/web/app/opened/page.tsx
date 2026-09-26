import type { Metadata } from "next";
import Link from "next/link";
import { DashboardFiltersForm } from "@/components/dashboard-filters";
import { Doodle } from "@/components/doodle";
import { Pagination } from "@/components/pagination";
import { RecruitingTimeline, type OpenedProgram } from "@/components/recruiting-timeline";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { formatShortDay } from "@/lib/dates";
import { emptyFilterOptions } from "@/lib/dashboard-query";
import { JUST_OPENED_FACETS, JUST_OPENED_PATH, justOpenedApplied, justOpenedFilters, justOpenedHref } from "@/lib/just-opened-filters";
import { openedRoles } from "@/lib/demo-data";
import { JUST_OPENED_DAYS, JUST_OPENED_PAGE_SIZE, hasServiceRoleConfig, loadJustOpened, type JustOpenedFeed } from "@/lib/real-data";

export const metadata: Metadata = {
  title: "Just opened",
  description: "Early-career programs whose postings went up in the last 45 days, newest first.",
};

// New openings arrive whenever collection runs; never a cached snapshot served as live.
export const dynamic = "force-dynamic";

/**
 * Every program that opened in the last 45 days, by the job boards' own dates, a page at a time. The feed keeps any one
 * company to two of every six items (lib/just-opened.ts); a company with more than that fits is linked to its own list,
 * `?company=<id>`, which is plain newest first.
 */
export default async function JustOpenedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // The same filters the main list reads, from the same keys, minus everything that describes a forecast.
  const filters = justOpenedFilters(params);
  const page = filters.page;
  const companyId = filters.companies[0] ?? null;
  const applied = justOpenedApplied(filters);
  const pageHref = (target: number) => justOpenedHref(filters, { page: target });
  let programs: OpenedProgram[] = [];
  let total = 0;
  let listed = 0;
  let matching = 0;
  let more: JustOpenedFeed["more"] = [];
  let company: JustOpenedFeed["company"] = null;
  let options = emptyFilterOptions;
  let mode: "real" | "demo" | "unconfigured" = "unconfigured";
  if (hasServiceRoleConfig()) {
    const data = await loadJustOpened(undefined, { limit: JUST_OPENED_PAGE_SIZE, offset: (page - 1) * JUST_OPENED_PAGE_SIZE, companyId, filters });
    programs = data.openings.map((opening) => ({
      id: opening.id,
      roleId: opening.roleId,
      company: opening.company,
      role: opening.role,
      details: [opening.programType, opening.place].join(" · "),
      openedOn: opening.openedOn,
      openedLabel: formatShortDay(opening.openedOn),
      applyUrl: opening.applyUrl,
    }));
    ({ total, matching, listed, more, company, options } = data);
    mode = "real";
  } else if (process.env.FIRSTSEEN_DEMO_MODE === "true" && !companyId) {
    // Development fixtures, labelled as such in the header; their sources are reserved .example addresses.
    programs = openedRoles.map((role) => ({ id: role.id, roleId: null, company: role.company, role: role.role, details: role.location, openedOn: null, openedLabel: role.openedAt, applyUrl: role.applyUrl }));
    total = matching = listed = programs.length;
    mode = "demo";
  }
  const first = (page - 1) * JUST_OPENED_PAGE_SIZE + 1;
  const last = first + programs.length - 1;
  const lastPage = last >= listed;
  const days = JUST_OPENED_DAYS;

  return (
    <>
      <SiteHeader
        active="opened"
        contentId="opened-content"
        status={mode === "demo" ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge> : undefined}
      />
      <main id="opened-content" className="fade-in mx-auto w-full max-w-4xl flex-1 px-4 py-8 md:px-6 md:py-10">
        {companyId && (
          <Link href="/opened" className="link-accent focus-ring mb-3 inline-flex min-h-touch items-center gap-1 text-caption"><Icon name="arrow-left" size={12} />Every company</Link>
        )}
        <h1 className="heading-display text-3xl leading-tight sm:text-4xl">{company ? `Just opened at ${company.name}` : "Just opened"}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">
          {mode === "unconfigured"
            ? companyId ? `Nothing to list for this company.` : "Live data is not configured here, so there is nothing to list."
            : total === 0
              ? companyId ? `No program at this company has opened in the last ${days} days.` : `No program has opened in the last ${days} days.`
              : applied.length > 0
                ? `${matching.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? "program" : "programs"} that opened in the last ${days} days match, newest first.`
                : company
                  ? `${total.toLocaleString("en-US")} ${total === 1 ? "program" : "programs"} at ${company.name} opened in the last ${days} days, newest first.`
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "program" : "programs"} opened in the last ${days} days. Newest first, mixed so one company cannot fill the list.`}
        </p>

        {/* A quiet stretch is a fact about the last 45 days, not a fault: the character says so beside the sentence. */}
        {mode === "real" && total === 0 && (
          <div className="card mt-8 flex flex-col items-center px-6 py-10 text-center">
            <Doodle name="chilling" size="empty" />
            <p className="mt-4 max-w-md text-sm leading-6 text-ink-muted">
              New openings arrive as collection runs.{" "}
              <Link href="/roles" className="link-accent focus-ring">Browse every program</Link> for the windows coming up.
            </p>
          </div>
        )}

        {mode !== "unconfigured" && (
          <div className="mt-6">
            <DashboardFiltersForm
              filters={filters}
              options={options}
              action={JUST_OPENED_PATH}
              facetsShown={JUST_OPENED_FACETS}
              searchLabel="Search company, program, or place"
              showWatched={false}
              sortShown={false}
            />
          </div>
        )}

        {mode === "real" && total > 0 && matching === 0 && (
          <div className="card mt-6 flex flex-col items-center px-6 py-10 text-center">
            <Doodle name="readingSide" size="empty" />
            <p className="mt-4 max-w-md text-sm leading-6 text-ink-muted">
              Nothing that opened in the last {days} days matches these filters.{" "}
              <Link href={JUST_OPENED_PATH} className="link-accent focus-ring">Clear them</Link> to see all {total.toLocaleString("en-US")}.
            </p>
          </div>
        )}

        {programs.length > 0 && <div className="mt-8"><RecruitingTimeline programs={programs} /></div>}
        {programs.length === 0 && listed > 0 && (
          <p className="mt-8 text-sm text-ink-muted">This page is past the last one. <Link href={pageHref(1)} className="link-accent focus-ring">Go to the newest</Link></p>
        )}

        {lastPage && more.length > 0 && (
          <ul className="mt-3 grid gap-3" aria-label="More from companies that posted many at once">
            {more.map((item) => (
              <li key={item.companyId}>
                <Link href={justOpenedHref(filters, { companies: [item.companyId], page: 1 })} className="card focus-ring flex min-h-touch items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-ink hover:bg-surface-hover">
                  <span>{item.count.toLocaleString("en-US")} more from {item.company}</span>
                  <Icon name="arrow-right" size={15} className="shrink-0 text-ink-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        {programs.length > 0 && (
          <Pagination page={page} size={JUST_OPENED_PAGE_SIZE} shown={programs.length} total={listed} href={pageHref} />
        )}
      </main>
    </>
  );
}
