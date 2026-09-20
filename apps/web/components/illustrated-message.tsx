import type { ReactNode } from "react";

import { Bird } from "@/components/brand/bird";

/**
 * The not-found and error pages' one layout: the bird first, then a headline, one sentence, one primary action, and
 * one small link, in a single centered column that fills the space between header and footer.
 *
 * The bird is confused here, which is the whole message before the words arrive: something looked and could not find
 * it. It is decorative, because the headline says what happened. It bobs once as the page appears, and not at all
 * under reduced motion (`bob-once`).
 */

export const primaryActionClass =
  "focus-ring inline-flex min-h-touch items-center justify-center gap-2 rounded-chip bg-accent px-7 text-base font-semibold text-ink-inverse hover:bg-accent-hover";
export const quietLinkClass = "focus-ring inline-flex min-h-touch items-center rounded-sm text-sm font-medium text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink";

function Character() {
  return (
    <div className="relative flex h-60 items-end justify-center md:h-[300px]">
      <span aria-hidden="true" className="absolute left-1/2 top-1/2 aspect-square h-[88%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-warm-soft" />
      <Bird pose="confused" className="bob-once relative h-full w-auto" />
    </div>
  );
}

export function IllustratedMessage({
  titleId,
  title,
  text,
  primary,
  secondary,
  alert = false,
}: {
  titleId: string;
  title: string;
  text: string;
  primary: ReactNode;
  secondary: ReactNode;
  /** Read the sentence out as soon as it appears (the error page). */
  alert?: boolean;
}) {
  return (
    <section className="flex w-full max-w-2xl flex-col items-center text-center" aria-labelledby={titleId}>
      <Character />
      <h1 id={titleId} className="heading-display mt-8 text-4xl leading-tight text-ink sm:text-5xl">{title}</h1>
      <p role={alert ? "alert" : undefined} className="mt-3 max-w-lg text-lg leading-7 text-ink-muted">{text}</p>
      <div className="mt-8">{primary}</div>
      <div className="mt-3">{secondary}</div>
    </section>
  );
}
