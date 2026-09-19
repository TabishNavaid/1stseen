/**
 * The characters that can answer a not-found page, each someone who looked and found nothing: diving into a box,
 * buried in a book, and feeling around with arms out (components/illustrated-message.tsx). Each visit gets one at
 * random; a not-found page is never cached (cloudflare/page-status.ts), so every visit renders afresh.
 *
 * Kept free of React so the tests read it directly.
 */

export const NOT_FOUND_ROTATION = ["unboxing", "reading", "zombieing"] as const;

export type NotFoundArt = (typeof NOT_FOUND_ROTATION)[number];

export function pickNotFoundArt(random: () => number = Math.random): NotFoundArt {
  const index = Math.floor(random() * NOT_FOUND_ROTATION.length);
  return NOT_FOUND_ROTATION[Math.min(Math.max(index, 0), NOT_FOUND_ROTATION.length - 1)];
}
