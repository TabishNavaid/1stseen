/**
 * Paging for PostgREST reads that are not bounded by construction.
 *
 * PostgREST caps a response (`db.max_rows`, 1,000 by default) and reports nothing
 * when it truncates, so an unpaged read of a table that has outgrown the cap silently
 * drops rows. That is how the dashboard once read 1,000 of 3,451 roles.
 *
 * Paging stops only on an empty page, never on a short one: a server configured with
 * a cap below PAGE_SIZE returns short pages that are not the end.
 *
 * No `server-only` import, so the helpers can be tested directly.
 */

export const PAGE_SIZE = 1000;
export const MAX_ROWS = 100_000;
/** Bounded `in (...)` batch size, so a large id list cannot build an oversized URL. */
export const IN_BATCH = 150;

export type PagedQuery<T> = {
  order: (column: string, options?: { ascending?: boolean }) => PagedQuery<T>;
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

/**
 * Every row of a query, page by page, over an order that ends in `key`: the relation's unique key (a column, or the
 * columns of a composite key). It is appended to whatever order the query already has, because offset paging over an
 * unordered or non-unique order can return one row twice and skip another between pages. Reaching MAX_ROWS throws
 * rather than returning a partial result that would read as complete. `tests/read-bounds.test.mjs` fails on any
 * PostgREST read that is neither paged here nor annotated with the hard cap that bounds it.
 */
export async function fetchAll<T>(query: () => PagedQuery<T>, label: string, key: string | readonly string[]): Promise<T[]> {
  const keys = typeof key === "string" ? [key] : [...key];
  if (keys.length === 0) throw new Error(`${label}: paging needs the relation's unique key`);
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    let ordered = query();
    for (const column of keys) ordered = ordered.order(column, { ascending: true });
    const { data, error } = await ordered.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}_read_failed`);
    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page);
    from += page.length;
    if (from >= MAX_ROWS) throw new Error(`${label}_read_exceeded_${MAX_ROWS}_rows`);
  }
}

export async function fetchAllIn<T>(
  query: (ids: string[]) => PagedQuery<T>,
  ids: string[],
  label: string,
  key: string | readonly string[],
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += IN_BATCH) {
    rows.push(...(await fetchAll(() => query(ids.slice(index, index + IN_BATCH)), label, key)));
  }
  return rows;
}
