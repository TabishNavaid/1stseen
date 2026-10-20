import { disciplineLabel, programTypeLabel, type DashboardListItem } from "@/lib/dashboard-query";
import { displayPlace } from "@/lib/display-names";

/**
 * Program type, discipline, and whatever distinguishes a role from its splits: location and program year.
 *
 * Not whether a posting is open. That used to be the last item here, which put the one fact a reader can act on
 * today in a footnote under a predicted date; the row leads with it instead (components/forecast-row.tsx).
 */
export function roleMeta(item: DashboardListItem): string {
  return [
    programTypeLabel(item.programType),
    disciplineLabel(item.discipline),
    item.location !== "unspecified" ? displayPlace(item.location) : null,
    item.targetYear ? `Program year ${item.targetYear}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
