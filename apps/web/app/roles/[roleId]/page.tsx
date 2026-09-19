import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoleIntelligencePage } from "@/components/role-intelligence-page";
import { fixtureRoleViews } from "@/lib/demo-data";
import { parsePlanOutcome } from "@/lib/onboarding";
import { hasServiceRoleConfig, loadRealRoleIdentity, loadRealRoleView } from "@/lib/real-data";
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

/** Which page of the forecast's contributions to render. Out-of-range values are clamped by the loader. */
function provenancePageFrom(params: Record<string, string | string[] | undefined>): number {
  const raw = Array.isArray(params.evidence) ? params.evidence[0] : params.evidence;
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The role's name only: one row, not the whole role view, which the page itself loads. */
async function resolveIdentity(roleId: string): Promise<{ company: string; role: string } | null> {
  if (hasServiceRoleConfig()) return loadRealRoleIdentity(roleId);
  const fixture = process.env.FIRSTSEEN_DEMO_MODE === "true" ? fixtureRoleViews[roleId] : undefined;
  return fixture ? { company: fixture.company, role: fixture.role } : null;
}

/**
 * The title needs only the role's name, so metadata reads one row rather than loading the role view a second time.
 * A role that is not in the product renders the not-found page; the Worker entry (cloudflare/index.ts) answers it with
 * 404, because by the time the page body runs the root loading boundary has already sent the shell.
 */
export async function generateMetadata({ params }: { params: Promise<{ roleId: string }> }): Promise<Metadata> {
  const { roleId } = await params;
  const identity = await resolveIdentity(roleId);
  if (!identity) return { title: "Role not found" };
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
  if (!view) notFound();
  // Where the first run lands: only a signed-in user who follows this role is told their watchlist is set.
  const outcome = parsePlanOutcome(query.welcome);
  const welcome = outcome && outcome !== "none" && view.isFollowed === true ? outcome : null;
  return <RoleIntelligencePage view={view} welcome={welcome} />;
}
