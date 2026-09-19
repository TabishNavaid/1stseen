import type { ReactNode } from "react";
import { FocusedShell } from "@/components/focused-shell";
import { formatDateWith } from "@/lib/dates";

/**
 * The frame for pages that are read rather than used: methodology and accuracy, and the terms, privacy, data-source,
 * and contact pages. A title, one plain paragraph that says what the page is for, an optional contents list, then
 * sections. Long-form text only; product data on these pages comes from the same readers every other page uses.
 */
export function DocumentPage({
  eyebrow,
  title,
  lede,
  updated,
  contents,
  draft = false,
  summary,
  children,
}: {
  eyebrow?: string;
  title: string;
  lede: ReactNode;
  /** Marks text still awaiting review (the policy pages, from `LEGAL_PAGES_ARE_DRAFTS` in lib/legal.ts). */
  draft?: boolean;
  /** When the text last changed in substance, as an ISO date. Shown so a reader can tell whether it moved since they read it. */
  updated?: string;
  contents?: ReadonlyArray<{ id: string; title: string }>;
  /** A short summary shown under the header, before the contents. */
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <FocusedShell>
      <article aria-labelledby="document-title">
        <header className="border-b border-line pb-6">
          {draft && (
            <p className="mb-3 flex flex-wrap items-center gap-2 text-caption text-ink-subtle">
              <span className="inline-flex items-center rounded-full border border-warning-line bg-warning-surface px-2 py-0.5 font-semibold text-warning-ink">Draft for review</span>
              <span>Not yet reviewed, and not yet in effect.</span>
            </p>
          )}
          {eyebrow && <p className="label-caps text-accent-ink">{eyebrow}</p>}
          <h1 id="document-title" className="heading-display mt-2 text-3xl leading-tight md:text-4xl">{title}</h1>
          <div className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">{lede}</div>
          {updated && <p className="mt-3 text-caption text-ink-subtle">Last updated <time dateTime={updated}>{formatDateWith(updated, { month: "long", day: "numeric", year: "numeric" })}</time></p>}
        </header>
        {summary}
        {contents && contents.length > 1 && (
          <nav aria-label="On this page" className="border-b border-line py-4">
            <p className="label-caps text-ink-subtle">On this page</p>
            <ol className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {contents.map((item) => (
                <li key={item.id}><a href={`#${item.id}`} className="link-accent focus-ring inline-flex min-h-touch items-center text-caption sm:min-h-0">{item.title}</a></li>
              ))}
            </ol>
          </nav>
        )}
        <div className="divide-y divide-line">{children}</div>
      </article>
    </FocusedShell>
  );
}

/** One section of a document page: a heading with an anchor, then prose. */
export function DocumentSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 py-7">
      <h2 id={`${id}-title`} className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-ink-muted [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

