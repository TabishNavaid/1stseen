import { cn } from "@/lib/utils";

/**
 * The hand-drawn characters the product draws beside a moment: the empty watchlist, the first run's questions, the
 * confirmation after a save. They are Open Doodles recoloured to the palette and self-hosted (docs/credits.md).
 *
 * Every one of them is decoration: the words beside it say what happened, so each is `aria-hidden` with an empty alt
 * and nothing is lost when it is not drawn. One character marks one moment, and no screenful holds two.
 *
 * `size` is the weight of the moment, not a measurement: `hero` for a section of its own, `empty` for a state with
 * nothing in it, `small` for a confirmation or a step. Each character bobs once as it arrives (`bob-once`), and stays
 * still under prefers-reduced-motion. `hideOnPhone` leaves out the ones that would push the words below the fold.
 */

export type Doodle = { src: string; width: number; height: number };

export const DOODLES = {
  /** Reading at a desk with the record beside them: how the openings are collected. */
  sittingReading: { src: "/illustrations/sitting-reading.svg", width: 906, height: 721 },
  /** Off at a run: the last word on the landing page, where watching starts. */
  sprinting: { src: "/illustrations/sprinting.svg", width: 975, height: 640 },
  /** Sitting and considering: the first question, what you are looking for. */
  meditating: { src: "/illustrations/meditating.svg", width: 881, height: 680 },
  /** Carrying a coffee: the second question, the fields worth watching. */
  coffee: { src: "/illustrations/coffee.svg", width: 936, height: 726 },
  /** Walking past the names: the third question, the companies you already watch. */
  strolling: { src: "/illustrations/strolling.svg", width: 757, height: 734 },
  /** Jumping: the first run's payoff, the programs that fit. */
  jumping: { src: "/illustrations/jumping.svg", width: 853, height: 693 },
  /** Carrying something to grow: a watchlist with nothing on it yet. */
  plant: { src: "/illustrations/plant.svg", width: 826, height: 775 },
  /** Lying down with a phone: a calendar with no dates on it yet. */
  laying: { src: "/illustrations/laying.svg", width: 984, height: 531 },
  /** Sitting back: a quiet stretch, when nothing has opened lately. */
  chilling: { src: "/illustrations/chilling.svg", width: 951, height: 613 },
  /** On a swing, unhurried: a question not asked yet. */
  swinging: { src: "/illustrations/swinging.svg", width: 785, height: 739 },
  /** Dancing: the programs are on the watchlist. */
  dancing: { src: "/illustrations/dancing.svg", width: 839, height: 710 },
  /** Leaping: the email address is confirmed. */
  groovy: { src: "/illustrations/groovy.svg", width: 918, height: 751 },
  /** Drifting: the link is on its way. */
  float: { src: "/illustrations/float.svg", width: 1046, height: 750 },
  /** Sitting with a phone: the sign-in page, beside the form. */
  sitting: { src: "/illustrations/sitting.svg", width: 779, height: 720 },
  /** Reading, having found nothing: a search or a filter that matched none. */
  readingSide: { src: "/illustrations/reading-side.svg", width: 978, height: 615 },
} as const satisfies Record<string, Doodle>;

export type DoodleName = keyof typeof DOODLES;

/**
 * 240 to 320px for a moment with a section of its own, 160 to 200 for a state with nothing in it, 96 to 120 for a
 * confirmation or the marker on one step of a question. The small one bobs by less, so the move stays proportionate.
 */
const SIZE = {
  hero: "h-60 sm:h-72 lg:h-80",
  empty: "h-40 sm:h-48",
  small: "h-24 sm:h-28 [--bob:4px]",
} as const;

export function Doodle({
  name,
  size = "empty",
  hideOnPhone = false,
  className,
}: {
  name: DoodleName;
  size?: keyof typeof SIZE;
  /** A phone's fold is close: leave the character out where it would push the words off the screen. */
  hideOnPhone?: boolean;
  className?: string;
}) {
  const art = DOODLES[name];
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a small self-hosted SVG, which the image optimizer skips
    <img
      src={art.src}
      alt=""
      aria-hidden="true"
      width={art.width}
      height={art.height}
      className={cn("bob-once w-auto max-w-full select-none", SIZE[size], hideOnPhone && "max-sm:hidden", className)}
    />
  );
}
