"use client";

import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { IllustratedMessage, primaryActionClass, quietLinkClass } from "@/components/illustrated-message";

/**
 * What a visitor sees when a page fails on the server. It says so plainly and offers a retry and a way home; what
 * failed stays in the logs, so the page shows no message, digest, or trace. The Worker entry answers it 500
 * (cloudflare/page-status.ts).
 */
export function BrokenPage({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col bg-canvas">
      <header className="border-b border-line bg-surface/90">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center px-4 md:px-6"><BrandMark /></div>
      </header>
      <main id="error-content" className="flex flex-1 items-center justify-center px-4 py-12 md:py-16">
        <IllustratedMessage
          titleId="error-title"
          title="Well, that tripped us up."
          text="Something broke on our side. Give it a minute and try again."
          alert
          primary={<button type="button" onClick={reset} className={primaryActionClass}>Try again</button>}
          secondary={<Link href="/" className={quietLinkClass}>Go home</Link>}
        />
      </main>
    </div>
  );
}
