/**
 * The first run's celebration, decided without React so the tests can pin it.
 *
 * Twelve pieces burst from the checkmark once. Under prefers-reduced-motion there are none at all: the payoff shows a
 * still checkmark, and the stylesheet also hides `.confetti` and drops every animation, so nothing moves either way.
 */

export type ConfettiPiece = { x: number; y: number; rotate: number; delay: number; tone: "accent" | "warm" | "warm-line" | "success" };

const TONES: ConfettiPiece["tone"][] = ["accent", "warm", "warm-line", "success"];
const PIECES = 12;

/** Evenly spread directions, so the burst looks the same on every visit and in every screenshot. */
export function confettiPieces(reducedMotion: boolean): ConfettiPiece[] {
  if (reducedMotion) return [];
  return Array.from({ length: PIECES }, (_, index) => {
    const angle = (index / PIECES) * Math.PI * 2 + 0.3;
    const distance = 90 + (index % 3) * 28;
    return {
      x: Math.round(Math.cos(angle) * distance),
      y: Math.round(Math.sin(angle) * distance * 0.8),
      rotate: (index % 2 ? 1 : -1) * (120 + index * 17),
      delay: (index % 4) * 40,
      tone: TONES[index % TONES.length],
    };
  });
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
