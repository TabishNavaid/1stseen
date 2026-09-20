import Link from "next/link";
import { BirdMark } from "@/components/brand/bird-mark";
import { cn } from "@/lib/utils";

/**
 * The 1stSeen wordmark, with the bird. Links home; the bird is decorative and the word names the link.
 *
 * `LOCKUP` is the one place the arrangement is decided, so the header, the footer, the first run and the error page
 * all wear the same one:
 *
 *  - `tile`    the bird fills the rounded accent tile the "1" used to. One shape, and it survives being small.
 *  - `perched` the "1" tile stays and the bird looks over the top of it, the way it looks over the chart card.
 *  - `beside`  no tile at all: the bird on the page's own paper, then the word.
 */
const LOCKUP: "tile" | "perched" | "beside" = "tile";

export function BrandLockup({ lockup = LOCKUP, inverse = false }: { lockup?: typeof LOCKUP; inverse?: boolean }) {
  return (
    <>
      {lockup === "tile" && (
        <span className="grid size-8 place-items-center overflow-hidden rounded-control bg-accent" aria-hidden="true">
          <BirdMark ground="tile" className="size-6" />
        </span>
      )}
      {lockup === "perched" && (
        <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-control bg-accent text-sm font-black text-ink-inverse" aria-hidden="true">
          <span className="mt-2.5">1</span>
          {/* Looking over the top of the tile, the way it looks over the top of the chart card. */}
          <BirdMark className="absolute -top-1.5 left-1/2 size-[1.3rem] -translate-x-1/2" />
        </span>
      )}
      {lockup === "beside" && <BirdMark className="size-9" />}
      <span className={cn("heading-display text-lg", inverse ? "text-ink-inverse" : "text-ink")}>1stSeen</span>
    </>
  );
}

export function BrandMark({ href = "/", className, inverse = false }: { href?: string; className?: string; inverse?: boolean }) {
  return (
    <Link href={href} className={cn("focus-ring inline-flex min-h-touch items-center gap-2 rounded-control", className)}>
      <BrandLockup inverse={inverse} />
    </Link>
  );
}
