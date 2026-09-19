import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/**
 * The top bar of every workspace page that is not the dashboard (role pages, calendar, replay, digests): back to the
 * intelligence view, the product mark, a status badge that gives way on a phone, and the page's own action. It
 * replaced three differently styled bars.
 */
export function WorkspaceHeader({ status, actions, contentId }: { status?: ReactNode; actions?: ReactNode; contentId: string }) {
  return (
    <>
      <a href={`#${contentId}`} className="sr-only z-[60] rounded-control bg-surface px-3 py-2 text-xs font-semibold text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-focus">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-3 px-4 md:px-6">
          <Link href="/" className="focus-ring -ml-1 inline-flex min-h-touch items-center gap-2 rounded-control px-1 text-xs font-semibold text-ink-muted hover:text-ink"><Icon name="arrow-left" size={15} />Intelligence</Link>
          <span className="hidden h-4 w-px bg-line sm:block" aria-hidden="true" />
          <span className="hidden items-center gap-2 sm:flex">
            <span className="grid h-6 w-6 place-items-center rounded-sm bg-accent text-micro font-bold text-ink-inverse" aria-hidden="true">1</span>
            <span className="text-sm font-semibold tracking-title">1stSeen</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            {status && <span className="hidden sm:inline-flex">{status}</span>}
            {actions}
          </div>
        </div>
      </header>
    </>
  );
}
