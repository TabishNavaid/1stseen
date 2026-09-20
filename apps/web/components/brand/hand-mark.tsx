import { HAND_MARKS, type HandMarkName } from "@/lib/brand/hand-art";
import { cn } from "@/lib/utils";

/**
 * One mark from the same pen the bird is drawn with: an arrow onto a dot, the ring a save is stamped with, the torn
 * edge of a sticker, a rule between two sections (lib/brand/hand-art.ts, drawn by scripts/build-brand-art.mjs with
 * perfect-freehand and written out as geometry).
 *
 * It is a filled outline rather than a stroke, so it keeps a pen's thick middle and thin ends at any size, and it
 * takes its colour from whatever is around it: `fill-current`, so a caller says `text-warm-ink` once.
 *
 * Every mark is decoration. A mark that carries meaning is a mark the sentence beside it should have carried.
 */
export function HandMark({ name, className }: { name: HandMarkName; className?: string }) {
  const mark = HAND_MARKS[name];
  return (
    <svg viewBox={mark.viewBox} aria-hidden="true" focusable="false" className={cn("pointer-events-none fill-current", className)}>
      <path d={mark.d} />
    </svg>
  );
}
