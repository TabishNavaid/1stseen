/**
 * Keyboard and filtering logic shared by the combobox and tabs primitives.
 *
 * Kept free of React and path aliases so it runs directly under `node --experimental-strip-types` in tests.
 */

export type ListOption = { value: string; label: string; description?: string };

/** Options whose label or description contains every word of the query, case- and accent-insensitively. */
export function filterOptions<T extends ListOption>(options: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = fold(`${option.label} ${option.description ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type NavigationKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End";

/**
 * The index a navigation key moves to in a list of `count` items, or -1 for an empty list.
 *
 * `current` of -1 means nothing is active: ArrowDown and ArrowRight start at the first item, ArrowUp and
 * ArrowLeft at the last. With `wrap`, moving past either end continues from the other (tabs); without it,
 * the ends hold (a listbox, where wrapping would hide that the list ended).
 */
export function nextIndex(current: number, key: NavigationKey, count: number, wrap: boolean): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const forward = key === "ArrowDown" || key === "ArrowRight";
  if (current < 0) return forward ? 0 : count - 1;
  const next = current + (forward ? 1 : -1);
  if (next >= count) return wrap ? 0 : count - 1;
  if (next < 0) return wrap ? count - 1 : 0;
  return next;
}

/** What a screen reader hears after the options change: "3 results" or the empty message. */
export function resultAnnouncement(count: number, emptyMessage: string): string {
  if (count === 0) return emptyMessage;
  return count === 1 ? "1 result" : `${count} results`;
}
