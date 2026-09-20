import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/ui/icon";

/**
 * The frame for single-purpose pages outside the app: settings and the sign-in and password pages. The way back to
 * the roles is always in the header, so no step can hold anyone in it.
 */
export function FocusedShell({ status, children, aside, width = "regular" }: { status?: ReactNode; children: ReactNode; aside?: ReactNode; width?: "regular" | "narrow" }) {
  return (
    <div className="flex-1 bg-canvas text-ink">
      <a href="#focused-content" className="sr-only z-[60] rounded-control bg-surface px-3 py-2 text-xs font-semibold text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-focus">Skip to content</a>
      <header className="border-b border-line bg-surface/90">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4 md:px-6">
          <BrandMark />
          <span className="ml-auto flex items-center gap-3">
            {status && <span className="text-caption text-ink-subtle">{status}</span>}
            <Link href="/roles" className="focus-ring inline-flex min-h-touch items-center gap-1.5 rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">
              <Icon name="arrow-left" size={15} />Browse programs
            </Link>
          </span>
        </div>
      </header>
      {aside ? (
        // The column keeps its own width and its place on the page; the character sits in the space beside it.
        <div className="mx-auto flex max-w-5xl items-center justify-center gap-16 px-4 py-12">
          <main id="focused-content" className="w-full max-w-[480px]">{children}</main>
          <div className="hidden shrink-0 lg:block">{aside}</div>
        </div>
      ) : (
        <main id="focused-content" className={width === "narrow" ? "mx-auto max-w-[480px] px-4 py-12" : "mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12"}>{children}</main>
      )}
    </div>
  );
}
