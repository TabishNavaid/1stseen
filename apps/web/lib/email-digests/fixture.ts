import type { DigestSourceData } from "./digest.ts";
import { forecastBasis } from "../forecast-basis.ts";

export const digestFixtureSource: DigestSourceData = {
  asOf: "2026-08-14",
  periodStart: "2026-08-07",
  forecasts: [
    { id: "fixture-forecast-northstar", roleId: "northstar-swe-intern", company: "Northstar", role: "Software Engineering Intern", windowStart: "2026-09-04", windowEnd: "2026-09-22", confidence: 71, basis: forecastBasis(0.74, 0.26), href: "http://localhost:3000/roles/northstar-swe-intern" },
    { id: "fixture-forecast-atlas", roleId: "atlas-data-science", company: "Atlas", role: "Data Science Intern", windowStart: "2026-08-28", windowEnd: "2026-09-10", confidence: 76, basis: forecastBasis(0.42, 0.58), href: "http://localhost:3000/" },
  ],
  changes: [
    { id: "fixture-change-atlas", forecastId: "fixture-forecast-atlas", roleId: "atlas-data-science", company: "Atlas", role: "Data Science Intern", changedOn: "2026-08-12", confidenceDelta: 5, reasons: ["A new role family appeared in the official ATS taxonomy."], href: "http://localhost:3000/" },
  ],
  openings: [
    { id: "fixture-opening-pioneer", roleId: "pioneer-product-intern", company: "Pioneer", role: "Product Management Intern", openedOn: "2026-08-13", href: "http://localhost:3000/" },
  ],
  milestones: [
    { id: "fixture-networking", forecastId: "fixture-forecast-northstar", roleId: "northstar-swe-intern", company: "Northstar", role: "Software Engineering Intern", kind: "networking", dueOn: "2026-08-16", href: "http://localhost:3000/roles/northstar-swe-intern" },
    { id: "fixture-resume", forecastId: "fixture-forecast-atlas", roleId: "atlas-data-science", company: "Atlas", role: "Data Science Intern", kind: "resume_ready", dueOn: "2026-08-15", href: "http://localhost:3000/" },
    { id: "fixture-referral", forecastId: "fixture-forecast-atlas", roleId: "atlas-data-science", company: "Atlas", role: "Data Science Intern", kind: "referral_contacts", dueOn: "2026-08-20", href: "http://localhost:3000/" },
  ],
};
