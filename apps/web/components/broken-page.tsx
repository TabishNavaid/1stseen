"use client";

import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * What a visitor sees when a page fails on the server. It says so plainly and offers a retry and two ways out; what
 * failed stays in the logs, so the page shows no message, digest, or trace. The Worker entry answers it 500
 * (cloudflare/page-status.ts).
 */
export function BrokenPage({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col bg-canvas">
      <header className="border-b border-line bg-surface/90">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center px-4 md:px-6"><BrandMark /></div>
      </header>
      <main id="error-content" className="flex-1">
        <section className="mx-auto max-w-xl px-4 py-16 text-center md:py-24" aria-labelledby="error-title">
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-warm-soft text-warm-ink" aria-hidden="true">
            <Icon name="wrench" size={24} />
          </span>
          <h1 id="error-title" className="heading-display mt-5 text-3xl leading-tight text-ink sm:text-4xl">Something broke on our side.</h1>
          <p role="alert" className="mt-3 text-base leading-7 text-ink-muted">Try again in a minute. Your watchlist and saved programs have not changed.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={reset} className="min-h-touch gap-2"><Icon name="rotate-cw" size={15} />Try again</Button>
            <Link href="/roles" className="focus-ring inline-flex min-h-touch items-center rounded-chip border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-hover">Explore roles</Link>
            <Link href="/" className="focus-ring inline-flex min-h-touch items-center rounded-chip border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-hover">Home</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
