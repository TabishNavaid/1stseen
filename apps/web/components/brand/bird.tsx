import { BIRD_ART, type BirdPose } from "@/lib/brand/bird-art";
import { cn } from "@/lib/utils";

/**
 * The bird, drawn inline (lib/brand/bird-art.ts, written by scripts/build-brand-art.mjs). It never costs a request
 * and never arrives after the words it belongs to.
 *
 * There is one of it, and it appears only where a person would feel something: looking out over the chart on the
 * landing page, pleased when a program is saved, asleep beside a watchlist with nothing on it, confused on a page
 * that is not there, waving when a way in is finished, and carrying a letter in a digest. Everywhere else the page
 * says what it means in words and leaves the bird out.
 *
 * `label` makes it an image worth announcing; without one it is decoration and is hidden, because the sentence beside
 * it already says what happened.
 */

/** 176 to 208px where the bird is the moment, 96 to 112 beside a confirmation, 56 to 72 tucked against something. */
const SIZE = {
  moment: "h-44 w-44 sm:h-52 sm:w-52",
  confirm: "h-24 w-24 sm:h-28 sm:w-28",
  tucked: "h-14 w-14 sm:h-[4.5rem] sm:w-[4.5rem]",
} as const;

export function Bird({
  pose,
  size = "moment",
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
