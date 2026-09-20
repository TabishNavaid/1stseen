import { HandMark } from "@/components/brand/hand-mark";
import { cn } from "@/lib/utils";

/**
 * The three small drawn things the product puts on top of its own surfaces: a sticker on a program that has only
 * just opened, a stamp on one that has just been saved, and the days left before a window is likely to open.
 *
 * Each is decoration over a fact the page already states in words, so a reader who cannot see it loses nothing: the
 * card says when it opened, the confirmation says it was saved, and the program page says the window.
 */

/** How new a posting has to be to be worth a sticker. Three days: long enough to catch, short enough to mean it. */
export const STICKER_DAYS = 3;

/** Whether an opening is new enough for the sticker, by whole days between its date and today. */
export function openedJustNow(openedOn: string | null, now: Date): boolean {
  if (!openedOn) return false;
  const days = (Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${openedOn}T00:00:00Z`)) / 86_400_000;
  return days >= 0 && days < STICKER_DAYS;
}

/** The torn coral sticker a just-opened card wears. The date beside it is what actually says when. */
export function NewSticker({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("pointer-events-none absolute -top-2.5 right-4 grid place-items-center", className)}>
      <HandMark name="stickerEdge" className="h-9 w-[4.5rem] text-warm-line" />
      <span className="hand absolute inset-0 grid place-items-center pb-1 text-base leading-none text-warm-ink">new!</span>
    </span>
  );
}

/**
 * The ring and tick a save is stamped with. It lands once, the way a stamp does, and under prefers-reduced-motion it
 * is simply already there (`stamp-in` in globals.css).
 */
export function SavedStamp({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("stamp-in relative grid size-24 place-items-center text-accent-ink", className)}>
      <HandMark name="stampRing" className="absolute inset-0 size-full" />
      <HandMark name="stampTick" className="absolute inset-0 size-full" />
    </span>
  );
}

/**
 * How long until a window is likely to open, in whole days. Null once the window has started, because "in 0 days" is
 * not a countdown and a window that is open is news of another kind.
 */
export function daysUntilWindow(windowStart: string, now: Date): number | null {
  const days = Math.ceil((Date.parse(`${windowStart}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return days > 0 ? days : null;
}

/** The countdown a program page carries, under the date it counts to. */
export function WindowCountdown({ days, className }: { days: number; className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 text-sm text-ink-muted", className)}>
      <HandMark name="underline" className="h-2 w-8 shrink-0 text-warm-line" />
      <span>
        About <strong className="font-semibold tabular text-ink">{days.toLocaleString("en-US")}</strong>{" "}
        {days === 1 ? "day" : "days"} until its window is likely to open
      </span>
    </p>
  );
}
