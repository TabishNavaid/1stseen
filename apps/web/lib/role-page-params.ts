/**
 * The query a role page reads.
 *
 * It lives here rather than in the page so that the guest edge cache can key on exactly what the page renders from.
 * When the two were written separately the cache keyed on the address alone, and a signed-out reader asking for the
 * second page of a forecast's contributions was served the first page someone else had asked for.
 */

/** Which page of the forecast's contributions to render. */
export const EVIDENCE_PARAM = "evidence";

/** Every query key a role page reads. A new one belongs here and in the cache key, which a test checks. */
export const ROLE_PAGE_PARAMS: readonly string[] = [EVIDENCE_PARAM];

/** Out-of-range and malformed values are page one, the same way the loader clamps them. */
export function provenancePageFrom(params: Record<string, string | string[] | undefined>): number {
  const raw = Array.isArray(params[EVIDENCE_PARAM]) ? params[EVIDENCE_PARAM][0] : params[EVIDENCE_PARAM];
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
