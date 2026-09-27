/**
 * A person's own details: the character they picked, where they study, and the two places early-career hiring looks.
 *
 * Kept free of React and of path aliases, the way lib/dashboard-query.ts is, so the page, the route, and the tests
 * all check one set of rules under `node --experimental-strip-types`. The two links are held as handles and the
 * address is built from one here — nothing stores a URL a page would then render, so there is no arbitrary address
 * to validate at render time (migration 202608140055).
 */

/**
 * The characters a person can be, by the names components/doodle.tsx draws them under. Eight rather than all
 * nineteen: enough that one feels chosen, few enough to read as a row. They are people doing something, not the
 * states the product draws beside an empty list. The component checks that each is a drawing it has; a name this
 * deployment does not know draws nothing rather than failing a read.
 */
export const AVATARS = ["meditating", "coffee", "strolling", "jumping", "dancing", "swinging", "chilling", "sittingReading"] as const;

export type AvatarName = (typeof AVATARS)[number];

export function isAvatar(value: unknown): value is AvatarName {
  return typeof value === "string" && (AVATARS as readonly string[]).includes(value);
}

/** What each service issues, so a handle that cannot be one is refused before it is stored. */
export const HANDLE_PATTERNS = {
  // GitHub: alphanumerics and single inner hyphens, 39 at most.
  github: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
  // LinkedIn public profile names are longer and allow hyphens anywhere after the first character.
  linkedin: /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/,
} as const;

export type HandleService = keyof typeof HANDLE_PATTERNS;

export const SCHOOL_MAX = 120;

/**
 * A handle out of a form. A person pastes the address as often as they type the name, so the address is accepted and
 * the handle taken out of it; anything else is refused rather than stored as typed.
 */
export function readHandle(service: HandleService, input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withoutAddress = text
    .replace(/^@/, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i, "")
    .replace(/[/?#].*$/, "");
  return HANDLE_PATTERNS[service].test(withoutAddress) ? withoutAddress : null;
}

/** Where a stored handle points. The only place either address is written. */
export function handleUrl(service: HandleService, handle: string): string {
  return service === "github" ? `https://github.com/${handle}` : `https://www.linkedin.com/in/${handle}`;
}

export function readSchool(input: string): string | null {
  const text = input.trim().replace(/\s+/g, " ").slice(0, SCHOOL_MAX);
  return text || null;
}

export const GRADUATION_YEARS = { first: 2000, last: 2100 } as const;

export function readGraduationYear(input: unknown): number | null {
  const year = typeof input === "number" ? input : Number.parseInt(String(input ?? ""), 10);
  if (!Number.isInteger(year) || year < GRADUATION_YEARS.first || year > GRADUATION_YEARS.last) return null;
  return year;
}
