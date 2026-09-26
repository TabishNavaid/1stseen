import type { Metadata } from "next";
import { MissingPage } from "@/components/missing-page";
import { RoleIntelligencePage } from "@/components/role-intelligence-page";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { provenancePageFrom } from "@/lib/role-page-params";
import { fixtureRoleViews } from "@/lib/demo-data";
import { parsePlanOutcome } from "@/lib/onboarding";
import { hasServiceRoleConfig, loadMissingRoleCompany, loadRealRoleIdentity, loadRealRoleView } from "@/lib/real-data";
import type { RoleView } from "@/lib/role-view";
import { currentSession } from "@/lib/session";

// Role evidence changes whenever collection runs, and readiness milestones are
// user-scoped, so this page is never served from a shared cached snapshot.
export const dynamic = "force-dynamic";

/**
 * Real data always wins. Fixture role pages render only when the deployment has
 * no service-role credentials *and* demo mode was explicitly requested, so a
 * production deployment can never serve a fixture role as live intelligence.
 */
async function resolveView(roleId: string, userId: string | null, provenancePage = 1): Promise<RoleView | null> {
  if (hasServiceRoleConfig()) return loadRealRoleView(roleId, userId, provenancePage);
  if (process.env.FIRSTSEEN_DEMO_MODE === "true") return fixtureRoleViews[roleId] ?? null;
  return null;
}

/** The role's name only: one row, not the whole role view, which the page itself loads. */
async function resolveIdentity(roleId: string): Promise<{ company: string; role: string } | null> {
  if (hasServiceRoleConfig()) return loadRealRoleIdentity(roleId);
  const fixture = process.env.FIRSTSEEN_DEMO_MODE === "true" ? fixtureRoleViews[roleId] : undefined;
  return fixture ? { company: fixture.company, role: fixture.role } : null;
}

/**
 * The title needs only the role's name, so metadata reads one row rather than loading the role view a second time.
 * A role that is not in the product renders "This program is no longer tracked"; the Worker entry answers it with 404
 * (cloudflare/page-status.ts), because by the time the page body runs the root loading boundary has already sent the shell.
 */
export async function generateMetadata({ params }: { params: Promise<{ roleId: string }> }): Promise<Metadata> {
  const { roleId } = await params;
  const identity = await resolveIdentity(roleId);
  if (!identity) return { title: "Program no longer tracked" };
  return {
    title: `${identity.company} ${identity.role}`,
    description: `Forecast, evidence precision, provenance, recruiting signals, and readiness timing for ${identity.company} ${identity.role}.`,
  };
}

export default async function RolePage({
  params,
  searchParams,
}: {
  params: Promise<{ roleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { roleId } = await params;
  const session = await currentSession();
  const query = await searchParams;
  const view = await resolveView(roleId, session?.userId ?? null, provenancePageFrom(query));
  if (!view) {
    return (
      <>
        <SiteHeader contentId="missing-content" />
        <MissingPage variant="program" company={await loadMissingRoleCompany(roleId)} />
      </>
    );
  }
  // Where the first run lands: only a signed-in user who follows this role is told their watchlist is set.
  const outcome = parsePlanOutcome(query.welcome);
  const welcome = outcome && outcome !== "none" && view.isFollowed === true ? outcome : null;
  const fixture = view.origin === "fixture";
  return (
    <>
      <SiteHeader
        contentId="role-content"
        status={fixture ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge> : undefined}
      />
      <RoleIntelligencePage view={view} welcome={welcome} />
    </>
  );
}
