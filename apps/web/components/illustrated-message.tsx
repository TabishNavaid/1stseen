import type { ReactNode } from "react";

/**
 * The not-found and error pages' one layout: a large hand-drawn character first, then a headline, one sentence, one
 * primary action, and one small link, in a single centered column that fills the space between header and footer.
 *
 * The characters are Open Doodles recoloured to the palette (docs/credits.md). Each is decorative: the headline says
 * what happened. The character bobs once when the page appears, and not at all under reduced motion (`bob-once`).
 */

export type Illustration = {
  src: string;
  width: number;
  height: number;
  /** A soft circle behind the character, or a shadow under it. */
  backdrop?: "circle" | "ground";
};

export const ILLUSTRATIONS = {
  unboxing: { src: "/illustrations/unboxing.svg", width: 858, height: 675 },
  reading: { src: "/illustrations/reading.svg", width: 619, height: 713, backdrop: "circle" },
  zombieing: { src: "/illustrations/zombieing.svg", width: 727, height: 685, backdrop: "ground" },
  clumsy: { src: "/illustrations/clumsy.svg", width: 992, height: 793 },
} as const satisfies Record<string, Illustration>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;

export const primaryActionClass =
  "focus-ring inline-flex min-h-touch items-center justify-center gap-2 rounded-chip bg-accent px-7 text-base font-semibold text-ink-inverse hover:bg-accent-hover";
export const quietLinkClass = "focus-ring inline-flex min-h-touch items-center rounded-sm text-sm font-medium text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink";

function Character({ art }: { art: Illustration }) {
  return (
    <div className="relative flex h-60 items-end justify-center md:h-[360px]">
      {art.backdrop === "circle" && (
        <span aria-hidden="true" className="absolute left-1/2 top-1/2 aspect-square h-[92%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-warm-soft" />
      )}
      {art.backdrop === "ground" && (
        <span aria-hidden="true" className="absolute -bottom-1 left-1/2 h-4 w-3/5 -translate-x-1/2 rounded-[50%] bg-line" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- a self-hosted SVG, drawn at its own size */}
      <img src={art.src} alt="" width={art.width} height={art.height} className="bob-once relative h-full w-auto max-w-full" />
    </div>
  );
}

export function IllustratedMessage({
  art,
  titleId,
  title,
  text,
  primary,
  secondary,
  alert = false,
}: {
  art: Illustration;
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
      <Character art={art} />
      <h1 id={titleId} className="heading-display mt-8 text-4xl leading-tight text-ink sm:text-5xl">{title}</h1>
      <p role={alert ? "alert" : undefined} className="mt-3 max-w-lg text-lg leading-7 text-ink-muted">{text}</p>
      <div className="mt-8">{primary}</div>
      <div className="mt-3">{secondary}</div>
    </section>
  );
}
