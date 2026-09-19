import { disciplineLabel, programTypeLabel, type DashboardListItem } from "@/lib/dashboard-query";

/** Program type, discipline, and whatever distinguishes a role from its splits: location and program year. */
export function roleMeta(item: DashboardListItem): string {
  return [
    programTypeLabel(item.programType),
    disciplineLabel(item.discipline),
    item.location !== "unspecified" ? item.location : null,
    item.targetYear ? `Program year ${item.targetYear}` : null,
    item.listedNow ? "Posting listed now" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The opening events behind a role, by date precision, in words. */
export function evidenceSummary(item: DashboardListItem): string {
  const parts = [
    item.exactEvents ? `${item.exactEvents} exact` : null,
    item.boundedEvents ? `${item.boundedEvents} bounded` : null,
    item.observedEvents ? `${item.observedEvents} observed by` : null,
  ].filter(Boolean);
  return parts.length ? `Openings recorded: ${parts.join(", ")}` : "No opening recorded";
}
