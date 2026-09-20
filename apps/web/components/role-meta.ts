import { disciplineLabel, programTypeLabel, type DashboardListItem } from "@/lib/dashboard-query";
import { displayPlace } from "@/lib/display-names";

/** Program type, discipline, and whatever distinguishes a role from its splits: location and program year. */
export function roleMeta(item: DashboardListItem): string {
  return [
    programTypeLabel(item.programType),
    disciplineLabel(item.discipline),
    item.location !== "unspecified" ? displayPlace(item.location) : null,
    item.targetYear ? `Program year ${item.targetYear}` : null,
    item.listedNow ? "Open now" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
