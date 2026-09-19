import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The 1stSeen wordmark: a rounded green tile with the "1" and a warm spark, the moment something is first seen.
 * Links home. The tile is decorative; the link is named by the wordmark text.
 */
export function BrandMark({ href = "/", className, inverse = false }: { href?: string; className?: string; inverse?: boolean }) {
  return (
    <Link href={href} className={cn("focus-ring inline-flex min-h-touch items-center gap-2 rounded-control", className)}>
      <span className="relative grid size-8 place-items-center rounded-control bg-accent text-sm font-black text-ink-inverse" aria-hidden="true">
        1
        <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface bg-warm" />
      </span>
      <span className={cn("heading-display text-lg", inverse ? "text-ink-inverse" : "text-ink")}>1stSeen</span>
    </Link>
  );
}
