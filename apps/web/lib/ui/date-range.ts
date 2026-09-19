/**
 * Validation for the date-range control. ISO calendar dates (YYYY-MM-DD) compare as strings.
 *
 * Kept free of React and path aliases so it runs directly under `node --experimental-strip-types` in tests.
 */

export type DateRangeProblem = "start_invalid" | "end_invalid" | "end_before_start" | "before_min" | "after_max";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The first problem with a range, or null. Either end may be empty: an open-ended range is valid, and a filter
 * with no dates set applies no date bound.
 */
export function dateRangeProblem(start: string, end: string, bounds: { min?: string; max?: string } = {}): DateRangeProblem | null {
  if (start && !isIsoDate(start)) return "start_invalid";
  if (end && !isIsoDate(end)) return "end_invalid";
  if (start && end && end < start) return "end_before_start";
  if (bounds.min && ((start && start < bounds.min) || (end && end < bounds.min))) return "before_min";
  if (bounds.max && ((start && start > bounds.max) || (end && end > bounds.max))) return "after_max";
  return null;
}

export function dateRangeMessage(problem: DateRangeProblem, bounds: { min?: string; max?: string } = {}): string {
  switch (problem) {
    case "start_invalid":
      return "Enter the start as a date.";
    case "end_invalid":
      return "Enter the end as a date.";
    case "end_before_start":
      return "The end date is before the start date.";
    case "before_min":
      return `Dates must be on or after ${bounds.min}.`;
    case "after_max":
      return `Dates must be on or before ${bounds.max}.`;
  }
}
