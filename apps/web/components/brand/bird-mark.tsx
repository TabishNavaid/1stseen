import { BIRD_MARK, type BirdMarkGround } from "@/lib/brand/bird-mark";
import { cn } from "@/lib/utils";

/**
 * The bird's head at mark weight (lib/brand/bird-mark.ts, drawn by scripts/build-brand-art.mjs): the head, the crest,
 * one eye and the beak, and nothing else, because a pose's legs and tail are a smudge below about 40 pixels.
 *
 * `ground` is what it is drawn on. On paper it keeps its ink outline; on the accent tile the outline is dropped and
 * the paper shape is the silhouette, which is the only way it survives 16 pixels.
 *
 * It is drawn inline like every other piece of the bird, so the wordmark never waits for a request, and it is
 * decoration: the word "1stSeen" beside it is what names the link.
 */
export function BirdMark({ ground = "paper", className }: { ground?: BirdMarkGround; className?: string }) {
  const art = BIRD_MARK[ground];
  return (
    <svg viewBox={art.viewBox} className={cn("shrink-0 select-none", className)} aria-hidden="true" focusable="false">
      {art.shapes.map((shape, index) =>
        shape.tag === "path" ? <path key={index} d={shape.d} fill={shape.fill} />
          : shape.tag === "circle" ? <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} fill={shape.fill} />
            : <ellipse key={index} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} fill={shape.fill} />,
      )}
    </svg>
  );
}
