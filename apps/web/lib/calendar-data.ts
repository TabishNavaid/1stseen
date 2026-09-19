import type { ForecastBasis } from "@/lib/forecast-basis";

export type CalendarEventType =
  | "networking"
  | "referrals"
  | "resume_ready"
  | "portfolio_ready"
  | "high_alert"
  | "predicted_start"
  | "predicted_end"
  | "confirmed_opening"
  | "confirmed_closing";

export type CalendarEvent = {
  id: string;
  date: string;
  company: string;
  role: string;
  roleId: string;
  roleFamily: string;
  type: CalendarEventType;
  label: string;
  semantics: "readiness" | "predicted" | "confirmed";
  detail: string;
  confidence?: number;
  /** A predicted boundary's forecast basis (lib/forecast-basis). */
  basis?: ForecastBasis;
  completed?: boolean;
  href: string;
  sourceUrl?: string;
};

// Development fixture calendar. Reserved `.example` sources only; never rendered in real mode.
export const fixtureCalendarEvents: CalendarEvent[] = [
  { id: "atlas-network", date: "2026-08-10", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "networking", label: "Start networking", semantics: "readiness", detail: "Begin warm outreach before the forecast enters high alert.", completed: true, href: "/" },
  { id: "lumen-open", date: "2026-08-12", company: "Lumen", role: "Strategy Analyst, New Grad", roleId: "lumen-analyst-new-grad", roleFamily: "Strategy", type: "confirmed_opening", label: "Applications opened", semantics: "confirmed", detail: "Confirmed from the company careers source and first observed two days ago.", href: "/", sourceUrl: "https://careers.lumen.example/analyst-new-grad" },
  { id: "pioneer-open", date: "2026-08-13", company: "Pioneer", role: "Product Management Intern", roleId: "pioneer-product-intern", roleFamily: "Product", type: "confirmed_opening", label: "Applications opened", semantics: "confirmed", detail: "Confirmed from the official ATS and first observed nineteen hours ago.", href: "/", sourceUrl: "https://jobs.pioneer.example/product-intern" },
  { id: "atlas-resume", date: "2026-08-15", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "resume_ready", label: "Resume-ready deadline", semantics: "readiness", detail: "Lock the role-specific resume before referral outreach begins.", href: "/" },
  { id: "northstar-network", date: "2026-08-16", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "networking", label: "Start networking", semantics: "readiness", detail: "Start early because the enterprise recruiting cycle is competitive.", href: "/roles/northstar-swe-intern" },
  { id: "atlas-portfolio", date: "2026-08-18", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "portfolio_ready", label: "Project-ready deadline", semantics: "readiness", detail: "Finish the project write-up before referral conversations.", href: "/" },
  { id: "atlas-referrals", date: "2026-08-20", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "referrals", label: "Identify referral contacts", semantics: "readiness", detail: "Have referral contacts identified before high-alert monitoring.", href: "/" },
  { id: "northstar-resume", date: "2026-08-23", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "resume_ready", label: "Resume-ready deadline", semantics: "readiness", detail: "Freeze the targeted resume twelve days before the predicted interval.", href: "/roles/northstar-swe-intern" },
  { id: "meridian-network", date: "2026-08-24", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "networking", label: "Start networking", semantics: "readiness", detail: "Begin alumni and product-community outreach.", href: "/" },
  { id: "northstar-referrals", date: "2026-08-24", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "referrals", label: "Identify referral contacts", semantics: "readiness", detail: "Map likely contacts before formal referral asks.", href: "/roles/northstar-swe-intern" },
  { id: "atlas-alert", date: "2026-08-25", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "high_alert", label: "High-alert monitoring", semantics: "readiness", detail: "Begin daily monitoring of official ATS and careers sources.", href: "/" },
  { id: "atlas-window-start", date: "2026-08-28", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "predicted_start", label: "Predicted window starts", semantics: "predicted", detail: "Start of the 80% prediction interval.", confidence: 76, href: "/" },
  { id: "meridian-resume", date: "2026-08-31", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "resume_ready", label: "Resume-ready deadline", semantics: "readiness", detail: "Complete the product-focused resume before portfolio proof is due.", href: "/" },
  { id: "northstar-alert", date: "2026-09-01", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "high_alert", label: "High-alert monitoring", semantics: "readiness", detail: "Begin daily checks three days before the predicted interval.", href: "/roles/northstar-swe-intern" },
  { id: "northstar-window-start", date: "2026-09-04", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "predicted_start", label: "Predicted window starts", semantics: "predicted", detail: "Start of the 80% prediction interval.", confidence: 71, href: "/roles/northstar-swe-intern" },
  { id: "meridian-portfolio", date: "2026-09-04", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "portfolio_ready", label: "Portfolio-ready deadline", semantics: "readiness", detail: "Prepare product artifacts and impact evidence.", href: "/" },
  { id: "atlas-window-end", date: "2026-09-10", company: "Atlas", role: "Data Science Intern", roleId: "atlas-data-science", roleFamily: "Data science", type: "predicted_end", label: "Predicted window ends", semantics: "predicted", detail: "End of the 80% prediction interval.", confidence: 76, href: "/" },
  { id: "northstar-window-end", date: "2026-09-22", company: "Northstar", role: "Software Engineering Intern", roleId: "northstar-swe-intern", roleFamily: "Software engineering", type: "predicted_end", label: "Predicted window ends", semantics: "predicted", detail: "End of the 80% prediction interval.", confidence: 71, href: "/roles/northstar-swe-intern" },
  { id: "meridian-referrals", date: "2026-09-24", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "referrals", label: "Identify referral contacts", semantics: "readiness", detail: "Complete referral mapping before the predicted opening interval.", href: "/" },
  { id: "meridian-alert", date: "2026-09-29", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "high_alert", label: "High-alert monitoring", semantics: "readiness", detail: "Increase monitoring ahead of the predicted interval.", href: "/" },
  { id: "meridian-window-start", date: "2026-10-02", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "predicted_start", label: "Predicted window starts", semantics: "predicted", detail: "Start of the 80% prediction interval.", confidence: 71, href: "/" },
  { id: "meridian-window-end", date: "2026-10-24", company: "Meridian", role: "Associate Product Manager", roleId: "meridian-apm", roleFamily: "Product", type: "predicted_end", label: "Predicted window ends", semantics: "predicted", detail: "End of the 80% prediction interval.", confidence: 71, href: "/" },
];
