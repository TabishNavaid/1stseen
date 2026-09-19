"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Popover } from "@/components/ui/overlay";
import { Chip } from "@/components/ui/status";
import {
  CONFIDENCE_BANDS,
  CYCLE_MINIMUMS,
  DISCIPLINES,
  PRECISIONS,
  PROGRAM_TYPES,
  SEASONS,
  SORTS,
  WINDOWS,
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

function selected(count: number): string | undefined {
  return count ? `${count} selected` : undefined;
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
 * The dashboard's filters as one GET form. Every control submits into the URL, so a filtered view is a link, the
 * back button works, and filtering needs no script beyond the popovers and the company combobox. Counts beside each
 * choice are in-scope roles. Applied filters are listed as chips, each a link to the same view without it.
 */
export function DashboardFiltersForm({ filters, options }: { filters: DashboardFilters; options: DashboardFilterOptions }) {
  const chips = activeFilters(filters, options);
  const timing = (filters.windowDays ? 1 : 0) + filters.seasons.length + filters.years.length;
  const evidence = filters.confidence.length + (filters.minCycles ? 1 : 0) + (filters.precision ? 1 : 0) + (filters.listedNow ? 1 : 0);

  return (
    <form
      method="get"
      action="/"
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field id="dashboard-query" label="Search company, role, or location" hideLabel className="min-w-0 flex-1">
          {(control) => <Input {...control} type="search" name="q" defaultValue={filters.query} placeholder="Search roles" />}
        </Field>
        <Field id="dashboard-sort" label="Sort roles" hideLabel className="sm:w-60">
          {(control) => (
            <Select {...control} name="sort" defaultValue={filters.sort}>
              {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          )}
        </Field>
        <Button type="submit" className="h-control">Apply</Button>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <Popover label="Discipline" summary={selected(filters.disciplines.length)}>
          <CheckboxGroup name="discipline" legend="Discipline" values={filters.disciplines} choices={DISCIPLINES.map(([value, label]) => ({ value, label, roles: rolesFor(options.discipline, value) }))} />
        </Popover>
        <Popover label="Program" summary={selected(filters.types.length)}>
          <CheckboxGroup name="type" legend="Program type" values={filters.types} choices={PROGRAM_TYPES.map(([value, label]) => ({ value, label, roles: rolesFor(options.type, value) }))} />
        </Popover>
        <Popover label="Timing" summary={selected(timing)}>
          <div className="grid w-64 gap-3">
            <Field id="dashboard-window" label="Forecast window">
              {(control) => (
                <Select {...control} name="window" defaultValue={filters.windowDays ? String(filters.windowDays) : ""}>
                  <option value="">Any time</option>
                  {WINDOWS.map((days) => <option key={days} value={days}>Opens within {days} days</option>)}
                </Select>
              )}
            </Field>
            <CheckboxGroup name="season" legend="Season" values={filters.seasons} choices={SEASONS.map(([value, label]) => ({ value, label, roles: rolesFor(options.season, value) }))} />
            <CheckboxGroup
              name="year"
              legend="Program year"
              values={filters.years}
              choices={options.year.map((option) => ({ value: option.value, label: option.value === "unstated" ? "Not stated in a title" : option.value, roles: option.roles }))}
            />
          </div>
        </Popover>
        <Popover label="Evidence" summary={selected(evidence)}>
          <div className="grid w-64 gap-3">
            <CheckboxGroup name="confidence" legend="Confidence" values={filters.confidence} choices={CONFIDENCE_BANDS.map(([value, label]) => ({ value, label }))} />
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
        </Popover>
        <Popover label="Company and location" summary={selected(filters.companies.length + filters.locations.length)}>
          <div className="grid w-72 gap-3">
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
        </Popover>
        <Checkbox id="dashboard-watched" name="watched" value="1" defaultChecked={filters.watchedOnly} label="Watched roles only" className="min-h-control" />
      </div>

      {chips.length > 0 && (
        <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => <Chip key={`${chip.key}-${chip.label}`} label={chip.label} removeHref={chip.removeHref} />)}
          <Link href={dashboardHref(defaultDashboardFilters, { sort: filters.sort })} className="link-accent focus-ring text-caption">Clear all filters</Link>
        </div>
      )}
    </form>
  );
}
