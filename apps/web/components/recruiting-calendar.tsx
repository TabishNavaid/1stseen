"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { GoogleCalendarSync } from "@/components/google-calendar-sync";
import { useOffCanvas } from "@/components/ui/off-canvas";
import { WorkspaceHeader } from "@/components/workspace-header";
import { confidencePhrase, formatConfidence } from "@/lib/confidence";
import { type CalendarEvent, type CalendarEventType } from "@/lib/calendar-data";
import { cn } from "@/lib/utils";
import { addDays, formatDateWith, utcDate } from "@/lib/dates";

export type CalendarMode = "real" | "demo" | "signed_out" | "unconfigured";

export type UnforecastableRole = {
  roleId: string;
  company: string;
  role: string;
  reason: string;
  lastObservedOn: string | null;
  cycleCount: number;
};

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const milestoneGroups: Array<{ value: string; label: string; types: CalendarEventType[] }> = [
  { value: "all", label: "All milestones", types: [] },
  { value: "networking", label: "Start networking", types: ["networking"] },
  { value: "referrals", label: "Identify referrals", types: ["referrals"] },
  { value: "resume", label: "Resume ready", types: ["resume_ready"] },
  { value: "portfolio", label: "Portfolio ready", types: ["portfolio_ready"] },
  { value: "alert", label: "High alert", types: ["high_alert"] },
  { value: "predicted", label: "Predicted openings", types: ["predicted_start", "predicted_end"] },
  { value: "confirmed", label: "Confirmed openings", types: ["confirmed_opening", "confirmed_closing"] },
];

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return formatDateWith(value, options);
}

/** Each date kind has its own semantic utility, a border style as well as colors, and a marker glyph, so color is never the only signal. */
const KIND = {
  confirmed: { utility: "date-confirmed", marker: "●", label: "Confirmed opening" },
  predicted: { utility: "date-predicted", marker: "◇", label: "Predicted opening" },
  readiness: { utility: "date-preparation", marker: "▪", label: "Preparation milestone" },
} as const;

function kindOf(event: CalendarEvent) {
  return event.semantics === "confirmed" ? KIND.confirmed : event.semantics === "predicted" ? KIND.predicted : KIND.readiness;
}

function CalendarChip({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const kind = kindOf(event);
  return <button type="button" onClick={onClick} className={cn("focus-ring w-full truncate rounded-sm border px-1.5 py-1 text-left text-micro font-semibold", kind.utility)} title={`${event.company}: ${event.label}`} aria-label={`${kind.label}: ${event.company}, ${event.label}, ${formatDate(event.date, { month: "long", day: "numeric" })}`}><span className="mr-1" aria-hidden="true">{kind.marker}</span>{event.company} · {event.label}</button>;
}

function EventDrawer({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const panelRef = useOffCanvas<HTMLElement>(true, onClose, "all");
  const kind = kindOf(event);
  return <><div className="fixed inset-0 z-40 bg-scrim" onClick={onClose} aria-hidden="true" /><aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="event-drawer-title" className="fixed inset-y-0 right-0 z-50 w-full max-w-[430px] overflow-y-auto border-l border-line-strong bg-surface p-5 shadow-dialog"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className={cn("inline-flex rounded-chip border px-2.5 py-1 text-micro font-semibold uppercase tracking-label", kind.utility)}>{kind.label}</span><p className="mt-5 text-xs font-semibold text-ink-muted">{event.company}</p><h2 id="event-drawer-title" className="mt-1 text-xl font-semibold tracking-title">{event.role}</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close event details"><Icon name="x" size={17} /></Button></div><div className="mt-6 border-y border-line py-4"><p className="label-caps text-ink-subtle">{event.label}</p><p className="mt-2 text-2xl font-semibold tabular">{formatDate(event.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>{event.confidence !== undefined && <p className="mt-1 text-caption text-ink-muted">Forecast {confidencePhrase(event.confidence)}</p>}{event.basis && <p className="mt-2"><ForecastBasisChip basis={event.basis} /></p>}</div><p className="mt-5 text-sm leading-6 text-ink-muted">{event.detail}</p>{event.semantics === "predicted" && <p className="mt-5 flex gap-2 border-l-2 border-date-predicted-line bg-date-predicted-surface px-3 py-2.5 text-caption text-date-predicted-ink"><Icon name="circle-dashed" size={13} className="mt-0.5" />A boundary of the forecast&apos;s 80% prediction interval.</p>}{event.semantics === "confirmed" && <p className="mt-5 flex gap-2 border-l-2 border-date-confirmed-line bg-date-confirmed-surface px-3 py-2.5 text-caption text-date-confirmed-ink"><Icon name="circle-check" size={13} className="mt-0.5" />A publication date the source supplied, from an observed posting.</p>}<div className="mt-7 space-y-2"><Link href={event.href} className="focus-ring flex min-h-touch items-center justify-between rounded-control bg-accent px-3 text-xs font-semibold text-ink-inverse hover:bg-accent-hover">Open role intelligence and evidence<Icon name="arrow-right" size={14} /></Link>{event.sourceUrl && <a href={event.sourceUrl} target="_blank" rel="noreferrer" className="focus-ring flex min-h-touch items-center justify-between rounded-control border border-line-strong px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">Open source record<Icon name="arrow-up-right" size={14} /></a>}</div></aside></>;
}

function EventRow({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const kind = kindOf(event);
  return <button type="button" onClick={onClick} className="focus-ring grid w-full grid-cols-[64px_minmax(0,1fr)] gap-3 px-4 py-3 text-left hover:bg-surface-hover md:grid-cols-[84px_minmax(0,1fr)_190px] md:items-center"><div><p className="text-xs font-semibold tabular">{formatDate(event.date, { month: "short", day: "numeric" })}</p><p className="mt-0.5 text-micro text-ink-subtle">{formatDate(event.date, { weekday: "short" })}</p></div><div className="min-w-0"><p className="text-xs font-semibold">{event.label}</p><p className="mt-1 truncate text-micro text-ink-subtle">{event.company} · {event.role}</p><span className={cn("mt-1.5 inline-flex rounded-chip border px-2 py-0.5 text-micro font-semibold md:hidden", kind.utility)}><span className="mr-1" aria-hidden="true">{kind.marker}</span>{event.semantics === "predicted" && event.confidence !== undefined ? `Predicted · score ${formatConfidence(event.confidence)}` : kind.label}</span>{event.basis && <span className="mt-1 block md:hidden"><ForecastBasisChip basis={event.basis} variant="plain" /></span>}</div><div className="hidden md:flex md:flex-col md:items-end md:gap-1"><span className={cn("inline-flex rounded-chip border px-2 py-0.5 text-micro font-semibold", kind.utility)}><span className="mr-1" aria-hidden="true">{kind.marker}</span>{event.semantics === "predicted" && event.confidence !== undefined ? `Predicted · score ${formatConfidence(event.confidence)}` : kind.label}</span>{event.basis && <ForecastBasisChip basis={event.basis} variant="plain" />}</div></button>;
}

export function RecruitingCalendar({
  mode,
  events,
  unforecastable = [],
  watchedRoleCount = 0,
  today,
}: {
  mode: CalendarMode;
  events: CalendarEvent[];
  unforecastable?: UnforecastableRole[];
  watchedRoleCount?: number;
  today: string;
}) {
  const [view, setView] = useState<"month" | "timeline">("month");
  const monthOptions = useMemo(() => {
    const keys = new Set(events.map((event) => event.date.slice(0, 7)));
    keys.add(today.slice(0, 7));
    return [...keys].sort().map((key) => ({
      key,
      label: formatDateWith(`${key}-01`, { month: "long", year: "numeric" }),
    }));
  }, [events, today]);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [company, setCompany] = useState("all");
  const [family, setFamily] = useState("all");
  const [milestone, setMilestone] = useState("all");
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const companies = [...new Set(events.map((event) => event.company))].sort();
  const families = [...new Set(events.map((event) => event.roleFamily))].sort();
  const selectedMilestone = milestoneGroups.find((group) => group.value === milestone) ?? milestoneGroups[0];
  const filtered = useMemo(() => events.filter((event) => (company === "all" || event.company === company) && (family === "all" || event.roleFamily === family) && (selectedMilestone.types.length === 0 || selectedMilestone.types.includes(event.type))), [events, company, family, selectedMilestone]);
  const monthEvents = filtered.filter((event) => event.date.startsWith(month));
  const weekStart = addDays(today, -((utcDate(today).getUTCDay() + 6) % 7));
  const weekEnd = addDays(weekStart, 6);
  const weekEvents = filtered.filter((event) => event.date >= weekStart && event.date <= weekEnd).sort((a, b) => a.date.localeCompare(b.date));
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  const cells: Array<number | null> = Array.from({ length: mondayOffset + daysInMonth }, (_, index) => index < mondayOffset ? null : index - mondayOffset + 1);
  while (cells.length % 7) cells.push(null);
  const monthIndex = Math.max(0, monthOptions.findIndex((item) => item.key === month));
  const isDemo = mode === "demo";

  const selectClass = "control appearance-none pl-2.5 pr-7 text-micro font-semibold sm:w-auto";
  const toggleClass = (active: boolean) => cn("focus-ring flex min-h-control-sm items-center gap-1.5 rounded-sm px-3 text-micro font-semibold max-sm:min-h-touch", active ? "bg-accent text-ink-inverse" : "text-ink-muted hover:text-ink");
  const monthLabel = monthOptions[monthIndex]?.label ?? month;
  const orderedMonthEvents = [...monthEvents].sort((a, b) => a.date.localeCompare(b.date));
  const noEvents = <div className="p-12 text-center"><Icon name="calendar-days" size={24} className="mx-auto text-ink-subtle" /><p className="mt-3 text-sm font-semibold">No matching calendar events</p><p className="mt-1 text-xs text-ink-subtle">Try changing the month or clearing a filter.</p></div>;

  return <div className="flex-1 bg-canvas text-ink">
    <WorkspaceHeader
      contentId="calendar-content"
      status={isDemo ? <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge> : mode === "real" ? <Badge className="border-success-line bg-success-surface text-success-ink">Your watched roles</Badge> : <Badge>Not signed in</Badge>}
    />
    <main id="calendar-content" className="mx-auto max-w-[1500px] px-4 py-6 md:px-6 md:py-8">
      <section className="grid gap-5 border-b border-line pb-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,.65fr)] lg:items-end" aria-labelledby="calendar-title">
        <div>
          <p className="label-caps flex items-center gap-2 text-accent-ink"><Icon name="calendar-days" size={13} />Watched recruiting plan</p>
          <h1 id="calendar-title" className="mt-3 text-3xl font-semibold tracking-title md:text-4xl">Recruiting Calendar</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-ink-muted">One timeline for preparation milestones, predicted opening windows, and openings that are actually confirmed.</p>
        </div>
        <div className="flex flex-col items-start gap-4 lg:items-end">
          <GoogleCalendarSync events={events} />
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-micro text-ink-muted" aria-label="Legend">
            {Object.values(KIND).map((kind) => <li key={kind.label} className="flex items-center gap-1.5"><span className={cn("grid h-4 w-5 place-items-center rounded-sm border text-[8px] leading-none", kind.utility)} aria-hidden="true">{kind.marker}</span>{kind.label}</li>)}
          </ul>
        </div>
      </section>

      {mode === "signed_out" && (
        <section className="panel mt-6 p-5" aria-labelledby="signed-out-title">
          <h2 id="signed-out-title" className="text-sm font-semibold">Sign in to see your recruiting calendar</h2>
          <p className="mt-1.5 max-w-2xl text-caption text-ink-muted">
            Calendar entries are built from your own watchlist, your readiness milestones, and the forecasts of the roles you
            follow.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/signin?mode=sign_up&return_to=%2Fwelcome" className="focus-ring inline-flex h-9 items-center rounded-control bg-accent px-3 text-xs font-semibold text-ink-inverse hover:bg-accent-hover max-sm:h-touch">Create an account</Link>
            <Link href="/signin?return_to=%2Fcalendar" className="focus-ring inline-flex h-9 items-center rounded-control border border-line-strong px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch">Sign in</Link>
          </div>
        </section>
      )}

      {mode === "unconfigured" && (
        <section className="mt-6 border border-danger-line bg-danger-surface p-5" aria-labelledby="unconfigured-title">
          <h2 id="unconfigured-title" className="text-sm font-semibold text-danger-ink">Live data is not configured</h2>
          <p className="mt-1.5 text-caption text-danger-ink">Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Development fixtures are never shown in production.</p>
        </section>
      )}

      {mode === "real" && watchedRoleCount === 0 && (
        <section className="panel mt-6 p-5" aria-labelledby="empty-title">
          <h2 id="empty-title" className="text-sm font-semibold">Your watchlist is empty</h2>
          <p className="mt-1.5 max-w-2xl text-caption text-ink-muted">
            This calendar fills itself from the roles you watch: their predicted opening windows, confirmed
            openings, and the preparation milestones worked back from each forecast. Answer four questions
            for a starting watchlist, or use Watch role on any role page.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href="/welcome" className="focus-ring inline-flex h-9 items-center rounded-control bg-accent px-3 text-xs font-semibold text-ink-inverse hover:bg-accent-hover max-sm:h-touch">Set up your watchlist</Link>
            <Link href="/" className="focus-ring inline-flex h-9 items-center rounded-control border border-line-strong px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch">Browse roles</Link>
          </div>
        </section>
      )}

      {unforecastable.length > 0 && (
        <section className="panel mt-6 p-5" aria-labelledby="unforecastable-title">
          <h2 id="unforecastable-title" className="flex items-center gap-2 text-sm font-semibold"><Icon name="circle-dashed" size={14} className="text-ink-subtle" />Watched roles with no calendar date yet</h2>
          <p className="mt-1.5 max-w-2xl text-caption text-ink-muted">
            The model has too little history to forecast these yet, so there is no window to work preparation back from.
          </p>
          <ul className="mt-3 space-y-2">
            {unforecastable.map((item) => (
              <li key={item.roleId} className="text-caption text-ink-muted">
                <Link href={`/roles/${item.roleId}`} className="font-semibold text-ink hover:underline">{item.company} — {item.role}</Link>
                <span> · {item.reason}</span>
                {item.lastObservedOn && <span> Last opening evidence {formatDate(item.lastObservedOn, { month: "short", day: "numeric", year: "numeric" })}.</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {events.length > 0 && <>
        <section className="mt-6 border border-line bg-surface-selected" aria-labelledby="this-week-title">
          <div className="grid gap-4 p-4 md:grid-cols-[210px_minmax(0,1fr)]">
            <div>
              <p className="label-caps text-accent-ink">{formatDate(weekStart)}–{formatDate(weekEnd)}</p>
              <h2 id="this-week-title" className="mt-1 text-lg font-semibold tracking-title">What you need to do this week</h2>
              <p className="mt-2 text-micro text-ink-muted">Today is {formatDate(today, { weekday: "long", month: "short", day: "numeric" })}.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {weekEvents.filter((event) => event.semantics === "readiness").map((event) => <button type="button" key={event.id} onClick={() => setSelected(event)} className="focus-ring flex items-start gap-3 border border-line bg-surface p-3 text-left hover:border-line-strong"><span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", event.completed ? "bg-success-line text-ink-inverse" : "border border-dotted border-date-preparation-line text-date-preparation-ink")} aria-hidden="true">{event.completed ? <Icon name="check" size={11} /> : <Icon name="clock-3" size={11} />}</span><div className="min-w-0"><p className="text-micro font-semibold text-ink-subtle">{formatDate(event.date)} · {event.company}</p><p className={cn("mt-1 text-xs font-semibold", event.completed && "text-ink-subtle line-through")}>{event.label}</p><p className="mt-1 truncate text-micro text-ink-subtle">{event.role}</p></div></button>)}
              {weekEvents.filter((event) => event.semantics === "readiness").length === 0 && <p className="col-span-full border border-dashed border-line-strong p-5 text-center text-xs text-ink-muted">No preparation milestone falls in this week.</p>}
            </div>
          </div>
        </section>

        <section className="panel mt-5" aria-label="Calendar">
          <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:items-center">
            <div className="flex self-start rounded-control border border-line-strong bg-surface-sunken p-0.5" role="group" aria-label="View">
              <button type="button" onClick={() => setView("month")} aria-pressed={view === "month"} className={toggleClass(view === "month")}><Icon name="calendar-days" size={12} />Month</button>
              <button type="button" onClick={() => setView("timeline")} aria-pressed={view === "timeline"} className={toggleClass(view === "timeline")}><Icon name="list" size={12} />Timeline</button>
            </div>
            <p className="label-caps flex items-center gap-2 text-ink-subtle lg:ml-auto"><Icon name="filter" size={13} />Filters</p>
            <div className="grid gap-2 sm:flex">
              {([[company, setCompany, "All companies", companies], [family, setFamily, "All role families", families], [milestone, setMilestone, "All milestones", milestoneGroups.map((item) => ({ value: item.value, label: item.label }))]] as const).map(([value, setter, allLabel, options]) => <label key={String(allLabel)} className="relative"><span className="sr-only">{String(allLabel)}</span><select value={String(value)} onChange={(event) => (setter as (value: string) => void)(event.target.value)} className={selectClass}><option value="all">{String(allLabel)}</option>{(options as ReadonlyArray<string | { value: string; label: string }>).filter((option) => typeof option === "string" || option.value !== "all").map((option) => typeof option === "string" ? <option key={option} value={option}>{option}</option> : <option key={option.value} value={option.value}>{option.label}</option>)}</select><Icon name="chevron-down" size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-subtle" /></label>)}
            </div>
          </div>

          {view === "month" ? <div>
            <div className="flex items-center justify-between border-b border-line px-2 py-1 sm:px-4">
              <button type="button" disabled={monthIndex <= 0} onClick={() => setMonth(monthOptions[monthIndex - 1].key)} className="focus-ring grid size-touch place-items-center rounded-control text-ink-muted hover:bg-surface-hover disabled:opacity-30" aria-label="Previous month"><Icon name="chevron-left" size={15} /></button>
              <h2 className="text-sm font-semibold tabular" aria-live="polite">{monthLabel}</h2>
              <button type="button" disabled={monthIndex >= monthOptions.length - 1} onClick={() => setMonth(monthOptions[monthIndex + 1].key)} className="focus-ring grid size-touch place-items-center rounded-control text-ink-muted hover:bg-surface-hover disabled:opacity-30" aria-label="Next month"><Icon name="chevron-right" size={15} /></button>
            </div>
            <div className="grid grid-cols-7 border-b border-line bg-surface-sunken" aria-hidden="true">{weekdays.map((day) => <div key={day} className="label-caps border-r border-line px-1 py-2 text-center text-ink-subtle last:border-0">{day}</div>)}</div>
            <div className="grid grid-cols-7">{cells.map((day, index) => {
              const date = day ? `${month}-${String(day).padStart(2, "0")}` : "";
              const dayEvents = day ? monthEvents.filter((event) => event.date === date) : [];
              return <div key={`${date}-${index}`} className={cn("min-h-[56px] border-b border-r border-line p-1 last:border-r-0 sm:min-h-[132px] sm:p-2", !day && "bg-surface-sunken", date === today && "bg-surface-selected")}>
                <div className="flex items-center justify-between"><span className={cn("grid h-5 w-5 place-items-center text-micro font-semibold tabular text-ink-muted", date === today && "rounded-full bg-accent text-ink-inverse")}>{day}</span>{dayEvents.length > 0 && <span className="hidden text-micro text-ink-subtle sm:inline">{dayEvents.length}</span>}</div>
                {dayEvents.length > 0 && <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden" aria-hidden="true">{dayEvents.slice(0, 4).map((event) => <span key={event.id} className={cn("grid h-3.5 w-3.5 place-items-center rounded-sm border text-[7px] leading-none", kindOf(event).utility)}>{kindOf(event).marker}</span>)}</div>}
                <div className="mt-1.5 hidden space-y-1 sm:block">{dayEvents.slice(0, 3).map((event) => <CalendarChip key={event.id} event={event} onClick={() => setSelected(event)} />)}{dayEvents.length > 3 && <span className="text-micro font-semibold text-ink-muted">+{dayEvents.length - 3} more</span>}</div>
              </div>;
            })}</div>
            <div className="border-t border-line sm:hidden">
              <h3 className="label-caps px-4 pb-1 pt-3 text-ink-subtle">{monthLabel}, day by day</h3>
              <div className="divide-y divide-line">{orderedMonthEvents.length ? orderedMonthEvents.map((event) => <EventRow key={event.id} event={event} onClick={() => setSelected(event)} />) : noEvents}</div>
            </div>
          </div> : <div className="divide-y divide-line">{orderedMonthEvents.length ? orderedMonthEvents.map((event) => <EventRow key={event.id} event={event} onClick={() => setSelected(event)} />) : noEvents}</div>}
          <div className="flex flex-col gap-2 border-t border-line bg-surface-sunken px-4 py-3 text-micro text-ink-subtle sm:flex-row sm:justify-between"><p>{monthEvents.length} events match this month and filter set.</p></div>
        </section>
      </>}
      {isDemo && <footer className="mt-7 border-t border-line py-4 text-micro text-ink-subtle"><p>Development fixture · reserved .example sources</p></footer>}
    </main>
    {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} />}
  </div>;
}
