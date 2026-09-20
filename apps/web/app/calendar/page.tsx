import type { Metadata } from "next";
import { RecruitingCalendar, type CalendarMode } from "@/components/recruiting-calendar";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { fixtureCalendarEvents } from "@/lib/calendar-data";
import { fixtureBasis } from "@/lib/demo-data";
import { hasGoogleCalendarConfig } from "@/lib/google-calendar/config";
import { hasServiceRoleConfig, loadRealCalendar } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Recruiting Calendar",
  description: "Watched opportunities, preparation milestones, predicted windows, and confirmed openings in one timeline.",
};

// User-owned readiness state and live forecasts; never a cached shared snapshot.
export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  if (hasServiceRoleConfig()) {
    const session = await currentSession();
    const data = await loadRealCalendar(session?.userId ?? null);
    return (
      <>
      <SiteHeader active="calendar" contentId="calendar-content" />
      <RecruitingCalendar
        mode={data.mode as CalendarMode}
        events={data.events}
        unforecastable={data.unforecastable}
        watchedRoleCount={data.watchedRoleCount}
        googleCalendar={hasGoogleCalendarConfig()}
        today={new Date().toISOString().slice(0, 10)}
      />
      </>
    );
  }
  const demo = process.env.FIRSTSEEN_DEMO_MODE === "true";
  return (
    <>
    <SiteHeader active="calendar" contentId="calendar-content" status={demo ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge> : undefined} />
    <RecruitingCalendar
      mode={demo ? "demo" : "unconfigured"}
      events={demo ? fixtureCalendarEvents.map((event) => (event.semantics === "predicted" ? { ...event, basis: fixtureBasis(event.roleId) ?? undefined } : event)) : []}
      today={demo ? "2026-08-14" : new Date().toISOString().slice(0, 10)}
    />
    </>
  );
}
