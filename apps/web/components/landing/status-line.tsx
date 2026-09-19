import { CountUp } from "@/components/count-up";
import type { LandingStatus } from "@/lib/landing-data";

/** "2 hours ago", from whole units, largest that fits. */
export function agoWords(from: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "a day ago" : `${days} days ago`;
}

/**
 * The line under the header: when collection last wrote anything, how many companies it follows, and how many programs
 * opened this month. It is drawn only when the data behind it is fresh (lib/landing-data.ts); a stalled deployment
 * says nothing rather than something out of date.
 */
export function StatusLine({ status, now = new Date() }: { status: LandingStatus | null; now?: Date }) {
  if (!status) return null;
  return (
    <p className="border-b border-line bg-surface/60 px-4 py-2 text-center text-caption text-ink-muted md:px-6">
      <span className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success-line opacity-70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success-line" />
          </span>
          Updated <time dateTime={status.updatedAt}>{agoWords(status.updatedAt, now)}</time>
        </span>
        <span aria-hidden="true">·</span>
        <span><CountUp value={status.programs} className="font-semibold tabular text-ink" /> programs</span>
        <span aria-hidden="true">·</span>
        <span><CountUp value={status.openingsThisMonth} className="font-semibold tabular text-ink" /> openings this month</span>
      </span>
    </p>
  );
}
