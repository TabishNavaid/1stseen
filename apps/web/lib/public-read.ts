import "server-only";

import { assertPublicRpc, assertPublicSelect, type PublicFunction, type PublicTable } from "@/lib/public-read-policy";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The dedicated public read path. Every read of non-user data goes through here, for guests and signed-in users
 * alike, and a read the allowlist in `public-read-policy.ts` does not cover throws before any request is made.
 *
 * It returns the query already narrowed to its checked columns, so a caller can filter, order, and page it but cannot
 * widen what it selects. User-owned rows (watchlists, milestones, preferences) are read elsewhere, with the service
 * role and an explicit user filter, and only when a session exists.
 */
export function createPublicReader() {
  const client = createAdminClient();
  return {
    // The select is checked at run time, so its rows are typed as plain records rather than parsed from the string
    // (supabase-js's select parser recurses without end on a union of table names).
    from(table: PublicTable, select: string) {
      assertPublicSelect(table, select);
      // bounded: returns a query builder; each caller's read is checked where it runs (tests/read-bounds.test.mjs).
      return client.from(table).select<string, Record<string, unknown>>(select);
    },
    /** How many rows match, and no rows: a total to show beside a list that is only its first page. */
    count(table: PublicTable, select: string) {
      assertPublicSelect(table, select);
      // bounded: head:true returns a count and no rows.
      return client.from(table).select<string, Record<string, unknown>>(select, { count: "exact", head: true });
    },
    rpc(fn: PublicFunction, args?: Record<string, unknown>) {
      assertPublicRpc(fn, args);
      // bounded: returns a query builder; each caller's read is checked where it runs (tests/read-bounds.test.mjs).
      return client.rpc(fn, args);
    },
  };
}

export type PublicReader = ReturnType<typeof createPublicReader>;
