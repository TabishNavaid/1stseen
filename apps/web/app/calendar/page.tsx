import type { Metadata } from "next";
import { RecruitingCalendar, type CalendarMode } from "@/components/recruiting-calendar";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { todayIso } from "@/lib/dates";
import { fixtureCalendarEvents } from "@/lib/calendar-data";
import { fixtureBasis } from "@/lib/demo-data";
import { hasGoogleCalendarConfig } from "@/lib/google-calendar/config";
import { hasServiceRoleConfig, loadRealCalendar } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Recruiting Calendar",
  description: "The programs you watch, your prep steps, predicted windows, and confirmed openings in one timeline.",
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
  // One clock for both modes. Demo mode used to pin today to "2026-08-14" so the fixture dates straddled it, which
  // froze the demo calendar in a month that had already passed and hid those dates rotting. They are offsets from
  // the day the page is rendered on now (lib/calendar-data.ts), so there is nothing left to pin.
  const today = todayIso();

  return (
    <>
    <SiteHeader active="calendar" contentId="calendar-content" status={demo ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge> : undefined} />
    <RecruitingCalendar
      mode={demo ? "demo" : "unconfigured"}
      events={demo ? fixtureCalendarEvents().map((event) => (event.semantics === "predicted" ? { ...event, basis: fixtureBasis(event.roleId) ?? undefined } : event)) : []}
      today={today}
    />
    </>
  );
}
