"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Popover } from "@/components/ui/overlay";
import { Chip } from "@/components/ui/status";
import { Icon } from "@/components/ui/icon";
import {
  CONFIDENCE_BANDS,
  CYCLE_MINIMUMS,
  DISCIPLINES,
  PRECISIONS,
  PROGRAM_TYPES,
  SEASONS,
  SORTS,
  WINDOWS,
  DASHBOARD_PATH,
  activeFilters,
  dashboardHref,
  defaultDashboardFilters,
  type DashboardFilterOptions,
  type DashboardFilters,
  type FilterOption,
} from "@/lib/dashboard-query";

type Choice = { value: string; label: string; roles?: number };

function rolesFor(options: FilterOption[], value: string): number {
  return options.find((option) => option.value === value)?.roles ?? 0;
}


function CheckboxGroup({ name, legend, values, choices }: { name: string; legend: string; values: readonly string[]; choices: Choice[] }) {
  return (
    <fieldset className="m-0 grid border-0 p-0">
      <legend className="label-caps mb-1 p-0 text-ink-subtle">{legend}</legend>
      {choices.map((choice) => (
        <Checkbox
          key={choice.value}
          id={`filter-${name}-${choice.value}`}
          name={name}
          value={choice.value}
          defaultChecked={values.includes(choice.value)}
          label={choice.roles === undefined ? choice.label : `${choice.label} (${choice.roles})`}
        />
      ))}
    </fieldset>
  );
}

/**
 * The dashboard's filters as one GET form, folded into one bar: search, one "Filters" menu holding every facet, and the
 * sort. Every control submits into the URL, so a filtered view is a link, the back button works, and filtering needs no
 * script beyond the menu and the company combobox. Counts beside each choice are in-scope roles. Applied filters are
 * listed as chips, each a link to the same view without it.
 */
export function DashboardFiltersForm({ filters, options, showWatched = true }: { filters: DashboardFilters; options: DashboardFilterOptions; showWatched?: boolean }) {
  const chips = activeFilters(filters, options);
  const timing = (filters.windowDays ? 1 : 0) + filters.seasons.length + filters.years.length;
  const evidence = filters.confidence.length + (filters.minCycles ? 1 : 0) + (filters.precision ? 1 : 0) + (filters.listedNow ? 1 : 0);
  const facets = filters.disciplines.length + filters.types.length + timing + evidence + filters.companies.length + filters.locations.length + (filters.watchedOnly ? 1 : 0);

  return (
    <form
      method="get"
      action={DASHBOARD_PATH}
      role="search"
      aria-label="Find roles"
      className="grid gap-3"
      onSubmit={(event) => {
        // Unset controls would add "window=&cycles=&company=" to every shared link. Disabled controls are not
        // submitted, so the URL names only the filters in force; without script the form still works, just noisier.
        for (const element of Array.from(event.currentTarget.elements)) {
          if ((element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.name && element.value === "" && element.type !== "checkbox") {
            element.disabled = true;
          }
        }
        if (event.currentTarget.querySelector<HTMLSelectElement>("select[name=sort]")?.value === "window") {
          event.currentTarget.querySelector<HTMLSelectElement>("select[name=sort]")!.disabled = true;
        }
      }}
    >
      <div className="card flex flex-col gap-2 p-2 sm:flex-row sm:items-center">
        <Field id="dashboard-query" label="Search company, role, or location" hideLabel className="min-w-0 flex-1">
          {(control) => (
            <div className="relative">
              <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <Input {...control} type="search" name="q" defaultValue={filters.query} placeholder="Search companies, roles, or places" className="h-11 rounded-chip pl-10 text-sm max-sm:h-touch" />
            </div>
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Popover
            label="Filters"
            summary={facets ? `${facets}` : undefined}
            leading={<Icon name="filter" size={14} />}
            buttonClassName="focus-ring inline-flex h-11 items-center gap-1.5 rounded-chip border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-hover"
            panelClassName="mt-2 w-[min(calc(100vw-2rem),44rem)] p-5 max-sm:-left-2"
          >
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <CheckboxGroup name="discipline" legend="Field" values={filters.disciplines} choices={DISCIPLINES.map(([value, label]) => ({ value, label, roles: rolesFor(options.discipline, value) }))} />
              <div className="grid content-start gap-6">
                <CheckboxGroup name="type" legend="Program type" values={filters.types} choices={PROGRAM_TYPES.map(([value, label]) => ({ value, label, roles: rolesFor(options.type, value) }))} />
                <CheckboxGroup name="season" legend="Season" values={filters.seasons} choices={SEASONS.map(([value, label]) => ({ value, label, roles: rolesFor(options.season, value) }))} />
              </div>
              <div className="grid content-start gap-4">
                <Field id="dashboard-window" label="Forecast window">
                  {(control) => (
                    <Select {...control} name="window" defaultValue={filters.windowDays ? String(filters.windowDays) : ""}>
                      <option value="">Any time</option>
                      {WINDOWS.map((days) => <option key={days} value={days}>Opens within {days} days</option>)}
                    </Select>
                  )}
                </Field>
                <Combobox
                  id="dashboard-company"
                  label="Company"
                  name="company"
                  options={options.company.map((option) => ({ value: option.value, label: option.label, description: `${option.roles} in-scope roles` }))}
                  defaultValue={filters.companies[0] ?? ""}
                  placeholder="Type a company"
                  emptyMessage="No company matches"
                />
                {filters.companies.slice(1).map((value) => <input key={value} type="hidden" name="company" value={value} />)}
                <Field id="dashboard-location" label="Location">
                  {(control) => (
                    <Select {...control} name="location" defaultValue={filters.locations[0] ?? ""}>
                      <option value="">Any location</option>
                      {options.location.map((option) => (
                        <option key={option.value} value={option.value}>{option.value === "unspecified" ? "Not specified" : option.label} ({option.roles})</option>
                      ))}
                    </Select>
                  )}
                </Field>
                {filters.locations.slice(1).map((value) => <input key={value} type="hidden" name="location" value={value} />)}
              </div>
            </div>
            <details className="group mt-5 border-t border-line pt-4">
              <summary className="focus-ring inline-flex min-h-touch cursor-pointer list-none items-center gap-1.5 rounded-chip text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
                Evidence and program year{evidence + filters.years.length ? ` (${evidence + filters.years.length})` : ""}
                <Icon name="chevron-down" size={13} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                <CheckboxGroup name="confidence" legend="Confidence" values={filters.confidence} choices={CONFIDENCE_BANDS.map(([value, label]) => ({ value, label }))} />
                <div className="grid content-start gap-4">
                  <Field id="dashboard-cycles" label="Cycles behind the forecast">
                    {(control) => (
                      <Select {...control} name="cycles" defaultValue={filters.minCycles ? String(filters.minCycles) : ""}>
                        <option value="">Any</option>
                        {CYCLE_MINIMUMS.map((count) => <option key={count} value={count}>{count} or more</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field id="dashboard-precision" label="Opening date precision">
                    {(control) => (
                      <Select {...control} name="precision" defaultValue={filters.precision ?? ""}>
                        <option value="">Any</option>
                        {PRECISIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Checkbox id="dashboard-listed" name="listed" value="1" defaultChecked={filters.listedNow} label="A posting is listed now" description="Present when its source was last collected." />
                </div>
                <CheckboxGroup
                  name="year"
                  legend="Program year"
                  values={filters.years}
                  choices={options.year.map((option) => ({ value: option.value, label: option.value === "unstated" ? "Not stated in a title" : option.value, roles: option.roles }))}
                />
              </div>
            </details>
            {showWatched && <Checkbox id="dashboard-watched" name="watched" value="1" defaultChecked={filters.watchedOnly} label="Only programs I watch" className="mt-3 border-t border-line pt-2" />}
            <div className="mt-4 flex justify-end border-t border-line pt-4">
              <Button type="submit" className="rounded-chip px-6">Show roles</Button>
            </div>
          </Popover>
          <Field id="dashboard-sort" label="Sort roles" hideLabel className="min-w-0 flex-1 sm:w-60 sm:flex-none">
            {(control) => (
              <Select {...control} name="sort" defaultValue={filters.sort} className="h-11 rounded-chip text-sm max-sm:h-touch">
                {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            )}
          </Field>
          <Button type="submit" className="h-11 rounded-chip px-3.5 sm:px-5 max-sm:size-touch"><Icon name="search" size={16} className="sm:hidden" /><span className="max-sm:sr-only">Search</span></Button>
        </div>
      </div>

      {chips.length > 0 && (
        <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => <Chip key={`${chip.key}-${chip.label}`} label={chip.label} removeHref={chip.removeHref} />)}
          <Link href={dashboardHref(defaultDashboardFilters, { sort: filters.sort })} className="link-accent focus-ring inline-flex min-h-touch items-center text-caption">Clear all filters</Link>
        </div>
      )}
    </form>
  );
}
