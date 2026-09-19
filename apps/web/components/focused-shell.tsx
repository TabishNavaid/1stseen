import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/**
 * The frame for single-purpose pages outside the dashboard: the first run and settings. The way back to the
 * dashboard is always in the header, so no step of the first run can hold anyone in it.
 */
export function FocusedShell({ status, children, width = "regular" }: { status?: ReactNode; children: ReactNode; width?: "regular" | "narrow" }) {
  return (
    <div className="flex-1 bg-canvas text-ink">
      <a href="#focused-content" className="sr-only z-[60] rounded-control bg-surface px-3 py-2 text-xs font-semibold text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-focus">Skip to content</a>
      <header className="border-b border-nav-line bg-nav text-nav-ink">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4 md:px-6">
          <Link href="/" className="inline-flex min-h-touch items-center gap-2 rounded-sm text-xs font-semibold text-nav-muted hover:text-ink-inverse focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nav-accent">
            <Icon name="arrow-left" size={15} />Intelligence
          </Link>
          <span className="h-4 w-px bg-nav-line" aria-hidden="true" />
          <span className="grid h-6 w-6 place-items-center rounded-sm bg-accent-soft text-micro font-black text-accent-ink" aria-hidden="true">1</span>
          <span className="text-sm font-semibold tracking-title">1stSeen</span>
          {status && <span className="ml-auto text-caption text-nav-subtle">{status}</span>}
        </div>
      </header>
      <main id="focused-content" className={width === "narrow" ? "mx-auto max-w-[480px] px-4 py-12" : "mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12"}>{children}</main>
    </div>
  );
}
