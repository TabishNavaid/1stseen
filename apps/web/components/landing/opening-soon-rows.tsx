import Link from "next/link";
import { CompanyMark } from "@/components/brand/company-mark";
import { ConfidenceMeter } from "@/components/confidence-meter";
import { windowRange } from "@/components/likely-window";
import { formatDay } from "@/lib/dates";
import { outlookLabel, outlookNote, windowState } from "@/lib/forecast-window";
import type { OpeningSoonRole } from "@/lib/landing-data";

/** A day as a number, so two dates can be compared and placed on one scale. Noon, so no offset can move the day. */
function dayNumber(iso: string): number {
  return Date.parse(`${iso}T12:00:00Z`) / 86_400_000;
}

/** Where a date sits on the shared scale, as a percentage of it. */
function position(iso: string, from: number, span: number): number {
  return ((dayNumber(iso) - from) / span) * 100;
}

/**
 * One window drawn on the scale the whole column shares: a dashed capsule spanning the predicted window, with a solid
 * tick where the model expects the opening. Dashed is the product's mark for a prediction, the same mark the date
 * above it is underlined with, so the bar cannot be mistaken for a confirmed run of dates.
 */
function WindowBar({ start, expected, end, from, span }: { start: string; expected: string; end: string; from: number; span: number }) {
  const left = position(start, from, span);
  const right = position(end, from, span);
  return (
    <span className="relative mt-2 flex h-5 w-full items-center" aria-hidden="true">
      <span className="absolute inset-x-0 h-px bg-line" />
      <span
        className="absolute h-3 rounded-full border border-dashed border-date-predicted-line bg-date-predicted-surface"
        style={{ left: `${left}%`, width: `${Math.max(right - left, 1)}%` }}
      />
      <span
        className="absolute h-5 w-0.5 -translate-x-px rounded-full bg-ink"
        style={{ left: `${position(expected, from, span)}%` }}
      />
    </span>
  );
}

function OpeningSoonRow({ role, today, from, span }: { role: OpeningSoonRole; today: string; from: number; span: number }) {
  const { forecast } = role;
  const state = windowState({ expected: forecast.expectedOpening, start: forecast.windowStart, end: forecast.windowEnd }, today);
  const note = outlookNote(state);
  return (
    <li data-reveal-item className="relative grid items-center gap-x-12 gap-y-4 border-t border-line py-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="min-w-0">
        <span className="flex items-center gap-3">
          <CompanyMark company={role.company} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink-muted">{role.company}</span>
            <span className="block text-caption text-ink-subtle">{role.programType}</span>
          </span>
        </span>
        <h3 className="mt-3 text-base font-semibold leading-snug text-ink">
          <Link href={`/roles/${role.roleId}`} className="focus-ring rounded-sm hover:underline after:absolute after:inset-0 after:content-['']">{role.role}</Link>
        </h3>
        <ConfidenceMeter value={forecast.confidence} className="mt-3" />
      </div>
      <div className="min-w-0">
        <p className="text-caption font-semibold text-ink-subtle">{outlookLabel(state)}</p>
        <p className="mt-1 tabular text-base font-semibold text-ink underline decoration-date-predicted-line decoration-dashed decoration-2 underline-offset-4">
          {formatDay(forecast.expectedOpening)}
        </p>
        <WindowBar start={forecast.windowStart} expected={forecast.expectedOpening} end={forecast.windowEnd} from={from} span={span} />
        <p className="mt-2 tabular text-caption text-ink-muted">
          {note ? <><span className="font-semibold text-warm-ink">{note}</span> · window {windowRange(forecast.windowStart, forecast.windowEnd)}</> : <>Window {windowRange(forecast.windowStart, forecast.windowEnd)}</>}
        </p>
      </div>
    </li>
  );
}

/**
 * The next windows, as rows on one scale.
 *
 * Every bar is measured against the same span — the earliest window start in the column to the latest window end — so
 * reading down the column shows which programs come first and how much wider one guess is than another. That
 * comparison was the strongest thing on the page and it only existed inside the hero's chart; in a grid of cards each
 * window was drawn to its own size and two of them could not be compared at all.
 */
export function OpeningSoonRows({ roles, today }: { roles: OpeningSoonRole[]; today: string }) {
  const from = Math.min(...roles.map((role) => dayNumber(role.forecast.windowStart)));
  const to = Math.max(...roles.map((role) => dayNumber(role.forecast.windowEnd)));
  // One day, when every window in the column is the same single day: a scale of zero width has no positions on it.
  const span = Math.max(to - from, 1);
  return (
    <ul className="m-0 mt-8 list-none p-0">
      {roles.map((role) => <OpeningSoonRow key={role.roleId} role={role} today={today} from={from} span={span} />)}
    </ul>
  );
}
