import type { Metadata } from "next";
import Link from "next/link";
import { RecruitingTimeline, type OpenedProgram } from "@/components/recruiting-timeline";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { formatShortDay } from "@/lib/dates";
import { openedRoles } from "@/lib/demo-data";
import { JUST_OPENED_DAYS, JUST_OPENED_PAGE_SIZE, hasServiceRoleConfig, loadJustOpened, type JustOpenedFeed } from "@/lib/real-data";

export const metadata: Metadata = {
  title: "Just opened",
  description: "Early-career programs whose postings went up in the last 45 days, newest first.",
};

// New openings arrive whenever collection runs; never a cached snapshot served as live.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pageFrom(params: Record<string, string | string[] | undefined>): number {
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 1000) : 1;
}

function companyFrom(params: Record<string, string | string[] | undefined>): string | null {
  const raw = Array.isArray(params.company) ? params.company[0] : params.company;
  return raw && UUID.test(raw) ? raw : null;
}

function pageHref(page: number, company: string | null): string {
  const query = new URLSearchParams();
  if (company) query.set("company", company);
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return search ? `/opened?${search}` : "/opened";
}

/**
 * Every program that opened in the last 45 days, by the job boards' own dates, a page at a time. The feed keeps any one
 * company to two of every six items (lib/just-opened.ts); a company with more than that fits is linked to its own list,
 * `?company=<id>`, which is plain newest first.
 */
export default async function JustOpenedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const page = pageFrom(params);
  const companyId = companyFrom(params);
  let programs: OpenedProgram[] = [];
  let total = 0;
  let listed = 0;
  let more: JustOpenedFeed["more"] = [];
  let company: JustOpenedFeed["company"] = null;
  let mode: "real" | "demo" | "unconfigured" = "unconfigured";
  if (hasServiceRoleConfig()) {
    const data = await loadJustOpened(undefined, { limit: JUST_OPENED_PAGE_SIZE, offset: (page - 1) * JUST_OPENED_PAGE_SIZE, companyId });
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
    ({ total, listed, more, company } = data);
    mode = "real";
  } else if (process.env.FIRSTSEEN_DEMO_MODE === "true" && !companyId) {
    // Development fixtures, labelled as such in the header; their sources are reserved .example addresses.
    programs = openedRoles.map((role) => ({ id: role.id, roleId: null, company: role.company, role: role.role, details: role.location, openedOn: null, openedLabel: role.openedAt, applyUrl: role.applyUrl }));
    total = listed = programs.length;
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
      <main id="opened-content" className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 md:px-6 md:py-10">
        {companyId && (
          <Link href="/opened" className="link-accent focus-ring mb-3 inline-flex min-h-touch items-center gap-1 text-caption"><Icon name="arrow-left" size={12} />Every company</Link>
        )}
        <p className="label-caps text-accent-ink">Posted in the last {days} days</p>
        <h1 className="heading-display mt-2 text-3xl leading-tight sm:text-4xl">{company ? `Just opened at ${company.name}` : "Just opened"}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">
          {mode === "unconfigured"
            ? companyId ? `Nothing to list for this company.` : "Live data is not configured on this deployment, so there is nothing to list."
            : total === 0
              ? companyId ? `No program at this company has opened in the last ${days} days.` : `No program has opened in the last ${days} days.`
              : company
                ? `${total.toLocaleString("en-US")} ${total === 1 ? "program" : "programs"} at ${company.name} opened in the last ${days} days, newest first. Each date is the day the company posted it.`
                : `${total.toLocaleString("en-US")} ${total === 1 ? "program" : "programs"} opened in the last ${days} days. Newest first, mixed so that no one company fills the list. Each date is the day the company posted it.`}
        </p>

        {programs.length > 0 && <div className="mt-8"><RecruitingTimeline programs={programs} /></div>}
        {programs.length === 0 && listed > 0 && (
          <p className="mt-8 text-sm text-ink-muted">This page is past the last one. <Link href={pageHref(1, companyId)} className="link-accent focus-ring">Go to the newest</Link></p>
        )}

        {lastPage && more.length > 0 && (
          <ul className="mt-3 grid gap-3" aria-label="More from companies that posted many at once">
            {more.map((item) => (
              <li key={item.companyId}>
                <Link href={pageHref(1, item.companyId)} className="card focus-ring flex min-h-touch items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-ink hover:bg-surface-hover">
                  <span>{item.count.toLocaleString("en-US")} more from {item.company}</span>
                  <Icon name="arrow-right" size={15} className="shrink-0 text-ink-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        )}

        {listed > JUST_OPENED_PAGE_SIZE && programs.length > 0 && (
          <nav className="mt-6 flex flex-wrap items-center justify-between gap-2 text-caption text-ink-subtle" aria-label="Pages">
            <span>{first.toLocaleString("en-US")}–{last.toLocaleString("en-US")} of {listed.toLocaleString("en-US")}{listed < total ? " in the feed" : ""}</span>
            <span className="flex items-center gap-2">
              {page > 1 && <Link href={pageHref(page - 1, companyId)} className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip border border-line-strong bg-surface px-4 font-semibold text-ink hover:bg-surface-hover"><Icon name="arrow-left" size={13} />Newer</Link>}
              {last < listed && <Link href={pageHref(page + 1, companyId)} className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip border border-line-strong bg-surface px-4 font-semibold text-ink hover:bg-surface-hover">Older<Icon name="arrow-right" size={13} /></Link>}
            </span>
          </nav>
        )}
      </main>
    </>
  );
}
