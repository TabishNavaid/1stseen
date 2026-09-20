import Link from "next/link";
import { BirdMark } from "@/components/brand/bird-mark";
import { cn } from "@/lib/utils";

/**
 * The 1stSeen wordmark: the bird on its tile, then the word. Links home; the bird is decorative and the word names
 * the link. The tile belongs to the drawing (design-refs/icon), so nothing here supplies one.
 *
 * `markId` names this copy's clip. A page carries the mark in its header and again in its footer, and two elements
 * cannot share an id, so the footer asks for its own.
 */
export function BrandMark({
  href = "/",
  markId = "brand-mark",
  className,
  inverse = false,
}: {
  href?: string;
  markId?: string;
  className?: string;
  inverse?: boolean;
}) {
  return (
    <Link href={href} className={cn("focus-ring inline-flex min-h-touch items-center gap-2 rounded-control", className)}>
      <BirdMark markId={markId} className="size-8" />
      <span className={cn("heading-display text-lg", inverse ? "text-ink-inverse" : "text-ink")}>1stSeen</span>
    </Link>
  );
}
