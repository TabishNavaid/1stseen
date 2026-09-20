import { BIRD_ART, type BirdPose } from "@/lib/brand/bird-art";
import { cn } from "@/lib/utils";

/**
 * The bird, drawn inline (lib/brand/bird-art.ts, written by scripts/build-brand-art.mjs). It never costs a request
 * and never arrives after the words it belongs to.
 *
 * It is the product's mark, not its cast. The people drawn by Open Doodles are what carry a moment at full size
 * (components/doodle.tsx); the bird turns up small beside them, the way a signature does: perched on the corner of
 * the chart card, next to the stamp on a save, beside a search that found nothing, at the head of a digest. One to a
 * screen, and never large enough to take a moment away from the person in it.
 *
 * `label` makes it an image worth announcing; without one it is decoration and is hidden, because the sentence beside
 * it already says what happened.
 */

/** 56 to 72px perched on the edge of something, 48 to 64 beside a moment, 40 to 44 beside a line of words. */
const SIZE = {
  perch: "h-14 w-14 sm:h-[4.5rem] sm:w-[4.5rem]",
  cameo: "h-12 w-12 sm:h-16 sm:w-16",
  tiny: "h-10 w-10 sm:h-11 sm:w-11",
} as const;

export function Bird({
  pose,
  size = "cameo",
  label,
  className,
}: {
  pose: BirdPose;
  size?: keyof typeof SIZE;
  /** What the bird is doing, when that is worth announcing. Decoration otherwise. */
  label?: string;
  className?: string;
}) {
  const art = BIRD_ART[pose];
  return (
    <svg
      viewBox={art.viewBox}
      className={cn("shrink-0 select-none overflow-visible", SIZE[size], className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {art.shapes.map((shape, index) =>
        shape.tag === "path" ? <path key={index} d={shape.d} fill={shape.fill} />
          : shape.tag === "circle" ? <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} fill={shape.fill} />
            : <ellipse key={index} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={shape.fill} />,
      )}
    </svg>
  );
}
