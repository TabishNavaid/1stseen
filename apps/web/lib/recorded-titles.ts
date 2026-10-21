/**
 * Read each role's recorded titles once per render, however many parts of the page name that role.
 *
 * The landing page read `role_aliases` twice: once inside `loadJustOpened` for the openings it shows, once for the
 * preview role and the opening-soon rows. Every role the two sets shared was read twice, and a role with no alias was
 * asked for again on the second read because nothing recorded that the answer was "none".
 *
 * The memo is per render, not per process: it is built where the render starts and goes away with it, so a later
 * request never sees a title this one read. No `server-only` import, so it can be tested directly.
 */

import type { RecordedTitle } from "@/lib/display-names";

export type RecordedTitlesReader = (roleIds: string[]) => Promise<Map<string, RecordedTitle[]>>;

/** Wraps a loader so each role id is asked for at most once, including the roles that have no recorded title. */
export function memoizedTitles(load: RecordedTitlesReader): RecordedTitlesReader {
  const seen = new Map<string, RecordedTitle[]>();
  return async (roleIds) => {
    const wanted = [...new Set(roleIds)];
    const missing = wanted.filter((id) => !seen.has(id));
    if (missing.length) {
      const loaded = await load(missing);
      // A role with no recorded alias is remembered as having none, so it is not asked for again.
      for (const id of missing) seen.set(id, loaded.get(id) ?? []);
    }
    return new Map(wanted.map((id) => [id, seen.get(id) ?? []]));
  };
}
