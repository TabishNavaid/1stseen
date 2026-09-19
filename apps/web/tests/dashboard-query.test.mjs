/**
 * Dashboard filters: URL state round-trips, every applied filter can be removed, the empty state's suggestion
 * is the filter that restores the most roles, and the view semantics (the same predicates, sort, and per-company
 * collapse as migration 202608140029) never hide a role without counting it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ROLES_PER_COMPANY,
  activeFilters,
  buildDashboardView,
  dashboardHref,
  defaultDashboardFilters,
  filterMatches,
  parseDashboardFilters,
  relaxSuggestion,
} from "../lib/dashboard-query.ts";

const COMPANY_A = "00000000-0000-4000-8000-00000000000a";
const COMPANY_B = "00000000-0000-4000-8000-00000000000b";

function paramsOf(href) {
  const url = new URL(href, "http://localhost");
  const params = {};
  for (const [key, value] of url.searchParams) params[key] = key in params ? [].concat(params[key], value) : value;
  return params;
}

function role(overrides) {
  return {
    id: overrides.id,
    companyId: COMPANY_A,
    company: "Alpha",
    role: "Software Engineer Intern",
    discipline: "software_engineering",
    programType: "internship",
    season: "summer",
    targetYear: 2027,
    location: "unspecified",
    listedNow: true,
    followed: false,
    forecastable: false,
    confidence: null,
    daysUntil: null,
    historyCount: null,
    exactEvents: 1,
    boundedEvents: 0,
    observedEvents: 0,
    searchText: "alpha software engineer intern",
    ...overrides,
  };
}

test("the default view applies no filter and sorts by forecast window", () => {
  assert.deepEqual(parseDashboardFilters({}), defaultDashboardFilters);
  assert.equal(dashboardHref(defaultDashboardFilters), "/roles", "the roles view lives at /roles; the front page is the landing page");
});

test("every filter round-trips through the URL, and malformed values are dropped", () => {
  const filters = {
    ...defaultDashboardFilters,
    query: "figma winter intern",
    disciplines: ["software_engineering", "design"],
    companies: [COMPANY_A],
    types: ["internship", "co_op"],
    seasons: ["winter"],
    years: ["2027", "unstated"],
    windowDays: 90,
    confidence: ["strong", "none"],
    minCycles: 3,
    precision: "exact_or_bounded",
    locations: ["new york ny"],
    listedNow: true,
    watchedOnly: true,
    sort: "evidence",
    page: 3,
  };
  const href = dashboardHref(filters, { page: 3 });
  assert.deepEqual(parseDashboardFilters(paramsOf(href)), filters);

  const parsed = parseDashboardFilters({
    discipline: ["quantitative", "astrology"],
    company: ["not-a-uuid", COMPANY_B.toUpperCase()],
    window: "45",
    cycles: "9",
    precision: "rumour",
    sort: "vibes",
    year: ["2027", "1999", "soon"],
    page: "-4",
  });
  assert.deepEqual(parsed.disciplines, ["quantitative"]);
  assert.deepEqual(parsed.companies, [COMPANY_B]);
  assert.equal(parsed.windowDays, null);
  assert.equal(parsed.minCycles, null);
  assert.equal(parsed.precision, null);
  assert.equal(parsed.sort, "window");
  assert.deepEqual(parsed.years, ["2027"]);
  assert.equal(parsed.page, 1);
});

test("changing a filter returns to the first page; paging keeps the filters", () => {
  const filters = { ...defaultDashboardFilters, disciplines: ["data"], page: 4 };
  assert.equal(parseDashboardFilters(paramsOf(dashboardHref(filters, { types: ["internship"] }))).page, 1);
  assert.equal(parseDashboardFilters(paramsOf(dashboardHref(filters, { page: 5 }))).page, 5);
  assert.deepEqual(parseDashboardFilters(paramsOf(dashboardHref(filters, { page: 5 }))).disciplines, ["data"]);
});

test("each applied filter value has a chip whose link removes exactly that value", () => {
  const filters = { ...defaultDashboardFilters, disciplines: ["data", "design"], windowDays: 30, watchedOnly: true };
  const chips = activeFilters(filters);
  assert.deepEqual(chips.map((chip) => chip.key), ["discipline", "discipline", "window", "watched"]);
  const withoutData = parseDashboardFilters(paramsOf(chips[0].removeHref));
  assert.deepEqual(withoutData.disciplines, ["design"]);
  assert.equal(withoutData.windowDays, 30);
  assert.equal(parseDashboardFilters(paramsOf(chips[2].removeHref)).windowDays, null);
});

test("a word search matches a program split across titles by any of its words, in any order", () => {
  const winter = role({ id: "w", company: "Figma", searchText: "figma product design intern winter san francisco" });
  const winterNy = role({ id: "n", company: "Figma", searchText: "figma product design intern winter new york" });
  const summer = role({ id: "s", company: "Figma", searchText: "figma software engineer intern summer" });
  const filters = { ...defaultDashboardFilters, query: "Figma winter intern" };
  assert.deepEqual([winter, winterNy, summer].filter((item) => filterMatches(item, filters).query).map((item) => item.id), ["w", "n"]);
});

test("the default view lists and counts roles without a forecast, after the forecasts", () => {
  const roles = [
    role({ id: "insufficient", company: "Alpha" }),
    role({ id: "forecast", companyId: COMPANY_B, company: "Beta", forecastable: true, confidence: 40, daysUntil: 200, historyCount: 2 }),
  ];
  const view = buildDashboardView(roles, defaultDashboardFilters, () => null);
  assert.deepEqual(view.items.map((item) => item.id), ["forecast", "insufficient"]);
  assert.equal(view.summary.matchingRoles, 2);
  assert.equal(view.summary.matchingInsufficient, 1);
});

test("a role with no stored forecast is never matched by a window filter or a confidence band", () => {
  const refused = role({ id: "refused", forecastable: false, confidence: null, daysUntil: null, historyCount: null });
  const matches = filterMatches(refused, { ...defaultDashboardFilters, windowDays: 30, confidence: ["strong"] });
  assert.equal(matches.window, false);
  assert.equal(matches.confidence, false);
  assert.equal(filterMatches(refused, { ...defaultDashboardFilters, confidence: ["none"] }).confidence, true);
});

// Migration 202608140035: a stored forecast is shown whatever its history, with its cycle count beside it, and the
// "cycles behind the forecast" filter is how a reader narrows to deeper histories.
test("a one-cycle forecast is listed as a forecast, and only the cycles filter narrows it out", () => {
  const oneCycle = role({ id: "one", forecastable: true, confidence: 52, daysUntil: 10, historyCount: 1 });
  const matches = filterMatches(oneCycle, { ...defaultDashboardFilters, windowDays: 30, confidence: ["limited"] });
  assert.equal(matches.window, true);
  assert.equal(matches.confidence, true);
  assert.equal(filterMatches(oneCycle, { ...defaultDashboardFilters, minCycles: 2 }).cycles, false);
  const view = buildDashboardView([oneCycle, role({ id: "none" })], defaultDashboardFilters, () => null);
  assert.deepEqual(view.items.map((item) => item.id), ["one", "none"]);
  assert.equal(view.summary.forecastableRoles, 1);
});

test("no company fills the first screen: extra roles are folded, counted, and reachable in the company view", () => {
  const roles = [
    ...Array.from({ length: 6 }, (_, index) => role({ id: `a${index}`, role: `Role ${index}` })),
    role({ id: "b0", companyId: COMPANY_B, company: "Beta" }),
  ];
  const view = buildDashboardView(roles, defaultDashboardFilters, () => null);
  const alpha = view.items.filter((item) => item.companyId === COMPANY_A);
  assert.equal(alpha.length, ROLES_PER_COMPANY);
  assert.deepEqual(alpha.map((item) => [item.companyRank, item.companyTotal]), [[1, 6], [2, 6], [3, 6]]);
  assert.equal(view.summary.matchingRoles, 7);
  assert.equal(view.summary.shownRoles, 4);
  assert.equal(view.summary.collapsedRoles, 3);
  assert.equal(view.summary.collapsedCompanies, 1);

  const companyView = buildDashboardView(roles, { ...defaultDashboardFilters, companies: [COMPANY_A] }, () => null);
  assert.equal(companyView.items.length, 6);
  assert.equal(companyView.summary.collapsedRoles, 0);
});

test("every filtered view counts what each filter excludes, and the suggestion restores the most roles", () => {
  const roles = [
    role({ id: "quant", discipline: "quantitative", searchText: "alpha quant intern" }),
    role({ id: "data", discipline: "data", programType: "new_grad" }),
    role({ id: "swe", discipline: "software_engineering", programType: "new_grad" }),
  ];
  const filters = { ...defaultDashboardFilters, disciplines: ["quantitative"], types: ["new_grad"] };
  const view = buildDashboardView(roles, filters, () => null);
  assert.equal(view.summary.matchingRoles, 0);
  assert.deepEqual(view.summary.exclusions.discipline, { excluded: 2, without: 2 });
  assert.deepEqual(view.summary.exclusions.type, { excluded: 1, without: 1 });
  assert.deepEqual(view.summary.exclusions.window, { excluded: 0, without: 0 });
  const relax = relaxSuggestion(filters, view.summary);
  assert.equal(relax.key, "discipline");
  assert.equal(relax.roles, 2);
  assert.deepEqual(parseDashboardFilters(paramsOf(relax.href)).types, ["new_grad"]);
  assert.equal(relaxSuggestion(defaultDashboardFilters, view.summary), null);
});
