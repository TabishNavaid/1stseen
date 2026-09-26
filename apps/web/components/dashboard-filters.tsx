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
  FILTER_KEYS,
  activeFilters,
  dashboardHref,
  defaultDashboardFilters,
  type DashboardFilterOptions,
  type DashboardFilters,
  type FilterKey,
  type FilterOption,
} from "@/lib/dashboard-query";

type Choice = { value: string; label: string; roles?: number };

function rolesFor(options: FilterOption[], value: string): number {
  return options.find((option) => option.value === value)?.roles ?? 0;
}


/**
 * One facet's choices. A choice nothing in the corpus matches is folded away: a list that offers Rotational (0),
 * Apprenticeship (0), Materials (0), Chemical (0) and Civil (0) reads as a broken filter rather than an honest
 * count, and it pushes the choices that do match below the fold. They are still reachable, behind one line, because
 * "nothing here yet" is itself worth being able to see; and a choice already applied is never folded away, so a
 * filter in force cannot vanish from the panel that sets it.
 */
function CheckboxGroup({ name, legend, values, choices }: { name: string; legend: string; values: readonly string[]; choices: Choice[] }) {
  const box = (choice: Choice) => (
    <Checkbox
      key={choice.value}
      id={`filter-${name}-${choice.value}`}
      name={name}
      value={choice.value}
      defaultChecked={values.includes(choice.value)}
      label={choice.roles === undefined ? choice.label : `${choice.label} (${choice.roles})`}
    />
  );
  const matched = choices.filter((choice) => choice.roles === undefined || choice.roles > 0 || values.includes(choice.value));
  const unmatched = choices.filter((choice) => !matched.includes(choice));
  return (
    <fieldset className="m-0 grid border-0 p-0">
      <legend className="label-caps mb-1 p-0 text-ink-subtle">{legend}</legend>
      {matched.map(box)}
      {unmatched.length > 0 && (
        <details className="group mt-1">
          <summary className="focus-ring inline-flex min-h-touch cursor-pointer list-none items-center gap-1 rounded-chip text-caption text-ink-subtle hover:text-ink [&::-webkit-details-marker]:hidden">
            {unmatched.length} with none yet
            <Icon name="chevron-down" size={11} className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid">{unmatched.map(box)}</div>
        </details>
      )}
    </fieldset>
  );
}

/**
 * The dashboard's filters as one GET form, folded into one bar: search, one "Filters" menu holding every facet, and the
 * sort. Every control submits into the URL, so a filtered view is a link, the back button works, and filtering needs no
 * script beyond the menu and the company combobox. Counts beside each choice are in-scope roles. Applied filters are
 * listed as chips, each a link to the same view without it.
 */
export function DashboardFiltersForm({
  filters,
  options,
  showWatched = true,
  action = DASHBOARD_PATH,
  facetsShown = FILTER_KEYS,
  searchLabel = "Search company, role, or location",
  sortShown = true,
}: {
  filters: DashboardFilters;
  options: DashboardFilterOptions;
  showWatched?: boolean;
  /** Which list this bar filters. Just opened submits to its own page and reads the same keys back. */
  action?: string;
  /** The facets this list has any use for. Just opened leaves out everything that describes a forecast. */
  facetsShown?: readonly FilterKey[];
  searchLabel?: string;
  /** Just opened is newest first and nothing else, so it offers no sort. */
  sortShown?: boolean;
}) {
  const shows = (key: FilterKey) => facetsShown.includes(key);
  const chips = activeFilters(filters, options, action).filter((chip) => shows(chip.key));
  const timing = (shows("window") && filters.windowDays ? 1 : 0) + (shows("season") ? filters.seasons.length : 0) + (shows("year") ? filters.years.length : 0);
  const evidence = shows("confidence") ? filters.confidence.length + (filters.minCycles ? 1 : 0) + (filters.precision ? 1 : 0) + (filters.listedNow ? 1 : 0) : 0;
  const facets = (shows("discipline") ? filters.disciplines.length : 0) + (shows("type") ? filters.types.length : 0) + timing + evidence
    + (shows("company") ? filters.companies.length : 0) + (shows("location") ? filters.locations.length : 0) + (filters.watchedOnly && showWatched ? 1 : 0);

  return (
    <form
      method="get"
      action={action}
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
        <Field id="dashboard-query" label={searchLabel} hideLabel className="min-w-0 flex-1">
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
            // The button sits at the right of the bar, so the panel hangs from its right edge and grows leftward;
            // hanging from the left edge ran a 44rem panel off the side of the screen on anything under about 1600px.
            align="end"
            buttonClassName="focus-ring inline-flex h-11 items-center gap-1.5 rounded-chip border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-hover"
            /*
             * It hangs from the button only where there is room to the left of it: a 44rem panel anchored to a
             * button that sits two thirds of the way across ran off one edge or the other on every laptop width.
             * Below lg it is a sheet pinned inside the screen instead, where no edge can be overrun at all, and at
             * lg it is 38rem, which is what fits beside the button at 1024. Either way it scrolls inside itself
             * rather than growing until the page has to.
             */
            panelClassName="fixed inset-x-3 bottom-3 top-auto mt-0 max-h-[70dvh] w-auto overflow-y-auto overscroll-contain p-5 lg:absolute lg:inset-x-auto lg:right-0 lg:bottom-auto lg:top-full lg:mt-2 lg:max-h-[min(70vh,34rem)] lg:w-[38rem] xl:w-[44rem]"
          >
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {shows("discipline") && <CheckboxGroup name="discipline" legend="Field" values={filters.disciplines} choices={DISCIPLINES.map(([value, label]) => ({ value, label, roles: rolesFor(options.discipline, value) }))} />}
              <div className="grid content-start gap-6">
                {shows("type") && <CheckboxGroup name="type" legend="Program type" values={filters.types} choices={PROGRAM_TYPES.map(([value, label]) => ({ value, label, roles: rolesFor(options.type, value) }))} />}
                {shows("season") && <CheckboxGroup name="season" legend="Season" values={filters.seasons} choices={SEASONS.map(([value, label]) => ({ value, label, roles: rolesFor(options.season, value) }))} />}
              </div>
              <div className="grid content-start gap-4">
                {shows("window") && (
                <Field id="dashboard-window" label="Forecast window">
                  {(control) => (
                    <Select {...control} name="window" defaultValue={filters.windowDays ? String(filters.windowDays) : ""}>
                      <option value="">Any time</option>
                      {WINDOWS.map((days) => <option key={days} value={days}>Opens within {days} days</option>)}
                    </Select>
                  )}
                </Field>
                )}
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
            {shows("confidence") && (
            <details className="group mt-5 border-t border-line pt-4">
              <summary className="focus-ring inline-flex min-h-touch cursor-pointer list-none items-center gap-1.5 rounded-chip text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
                Evidence and program year{evidence + filters.years.length ? ` (${evidence + filters.years.length})` : ""}
                <Icon name="chevron-down" size={13} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
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
            )}
            {showWatched && <Checkbox id="dashboard-watched" name="watched" value="1" defaultChecked={filters.watchedOnly} label="Only programs I watch" className="mt-3 border-t border-line pt-2" />}
            <div className="mt-4 flex justify-end border-t border-line pt-4">
              <Button type="submit" className="rounded-chip px-6">Show roles</Button>
            </div>
          </Popover>
          {sortShown && (
          <Field id="dashboard-sort" label="Sort roles" hideLabel className="min-w-0 flex-1 sm:w-60 sm:flex-none">
            {(control) => (
              <Select {...control} name="sort" defaultValue={filters.sort} className="h-11 rounded-chip text-sm max-sm:h-touch">
                {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            )}
          </Field>
          )}
          <Button type="submit" className="h-11 rounded-chip px-3.5 sm:px-5 max-sm:size-touch"><Icon name="search" size={16} className="sm:hidden" /><span className="max-sm:sr-only">Search</span></Button>
        </div>
      </div>

      {chips.length > 0 && (
        <div role="group" aria-label="Applied filters" className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => <Chip key={`${chip.key}-${chip.label}`} label={chip.label} removeHref={chip.removeHref} />)}
          <Link href={dashboardHref(defaultDashboardFilters, { sort: filters.sort }, action)} className="link-accent focus-ring inline-flex min-h-touch items-center text-caption">Clear all filters</Link>
        </div>
      )}
    </form>
  );
}
