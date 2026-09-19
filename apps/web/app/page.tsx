import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LandingPage } from "@/components/landing/landing-page";
import { SiteHeader } from "@/components/site-header";
import { DASHBOARD_PATH, DASHBOARD_PARAMS } from "@/lib/dashboard-query";
import { loadLandingData } from "@/lib/landing-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: { absolute: "1stSeen: know when internships open, before everyone else" },
  description: "1stSeen learns when each internship, co-op, and new-grad program opens every year and shows you when it is likely to open next.",
};

// The landing page shows real programs, which change as collection runs.
export const dynamic = "force-dynamic";

/**
 * The front door. A first-time visitor gets the landing page, never the app. A signed-in user goes to their roles, and
 * an old link to a filtered dashboard (`/?company=…`, from before the roles view moved to /roles) keeps working.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!DASHBOARD_PARAMS.includes(key)) continue;
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  if (query.size > 0) redirect(`${DASHBOARD_PATH}?${query.toString()}`);
  if (await currentSession()) redirect(DASHBOARD_PATH);
  // The landing explains the product; if its reads fail, it still renders, with the illustration in place of the card.
  const data = await loadLandingData().catch(() => null);
  return <LandingPage data={data} header={<SiteHeader contentId="landing-content" />} />;
}
