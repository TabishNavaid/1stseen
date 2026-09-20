"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, RadioGroup } from "@/components/ui/choice";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input, Select } from "@/components/ui/input";
import { Dialog, Popover, Tooltip } from "@/components/ui/overlay";
import { Chip, EmptyState, LoadingRegion, Skeleton } from "@/components/ui/status";
import { DateRangeField, Tabs } from "@/components/ui/tabs";

// Interface examples only. None of this is recruiting data, and the page renders only in development.
const EXAMPLE_OPTIONS = [
  { value: "example-a", label: "Example Company A", description: "12 roles in scope" },
  { value: "example-b", label: "Example Company B", description: "4 roles in scope" },
  { value: "example-c", label: "Example Company C", description: "No role in scope" },
  { value: "example-d", label: "Exemplar Labs", description: "7 roles in scope" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel p-5" aria-labelledby={`section-${title.replace(/\W+/g, "-").toLowerCase()}`}>
      <h2 id={`section-${title.replace(/\W+/g, "-").toLowerCase()}`} className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function DesignSystemGallery() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chips, setChips] = useState(["Internship", "Software engineering", "Next 90 days"]);

  return (
    <main className="mx-auto grid max-w-5xl gap-5 px-4 py-8">
      <header>
        <p className="label-caps text-ink-subtle">Development only</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-title">1stSeen design system</h1>
        <p className="mt-1 text-xs text-ink-subtle">Every primitive, for keyboard and screen-reader verification. The examples are interface text, not data.</p>
      </header>

      <Section title="Text input and select">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="gallery-query" label="Search roles" description="Company or role title">
            {(control) => <Input {...control} name="q" placeholder="Search company or role" />}
          </Field>
          <Field id="gallery-sort" label="Sort by">
            {(control) => (
              <Select {...control} name="sort" defaultValue="window">
                <option value="window">Soonest window</option>
                <option value="confidence">Confidence</option>
              </Select>
            )}
          </Field>
          <Field id="gallery-invalid" label="Minimum cycles" error="Enter a whole number of cycles.">
            {(control) => <Input {...control} inputMode="numeric" defaultValue="two" />}
          </Field>
        </div>
      </Section>

      <Section title="Combobox with search">
        <Combobox id="gallery-company" label="Company" name="company" options={EXAMPLE_OPTIONS} placeholder="Type to filter" description="Arrow keys move, Enter chooses, Escape closes." emptyMessage="No company matches" />
      </Section>

      <Section title="Checkbox and radio group">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <Checkbox id="gallery-watched" name="watched" label="Only programs I watch" description="Programs you follow, including those without a forecast." />
            <Checkbox id="gallery-insufficient" name="insufficient" label="Include roles with too little history" defaultChecked />
          </div>
          <RadioGroup name="track" legend="Track" defaultValue="all" options={[{ value: "all", label: "All tracks" }, { value: "internship", label: "Internship" }, { value: "new_grad", label: "New grad", description: "Full-time programs for recent graduates." }]} />
        </div>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap gap-2" aria-label="Applied filters" role="group">
          {chips.map((chip) => <Chip key={chip} label={chip} onRemove={() => setChips((current) => current.filter((item) => item !== chip))} />)}
          <Chip label="Company: Example Company A" removeHref="/design-system" />
          <Chip label="Read-only chip" />
        </div>
      </Section>

      <Section title="Popover, dialog, and tooltip">
        <div className="flex flex-wrap items-center gap-3">
          <Popover label="Discipline" summary="2 selected">
            <Checkbox id="gallery-pop-swe" label="Software engineering" defaultChecked />
            <Checkbox id="gallery-pop-quant" label="Quantitative" defaultChecked />
            <Checkbox id="gallery-pop-hw" label="Hardware" />
          </Popover>
          <Button type="button" variant="outline" onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Tooltip content="Confidence comes only from the forecast model, never from the agent.">
            <button type="button" className="focus-ring grid size-touch place-items-center rounded-control text-ink-subtle hover:bg-surface-hover" aria-label="About confidence">
              <Icon name="circle-help" size={16} />
            </button>
          </Tooltip>
        </div>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Stop watching this role?"
          description="You will no longer see its updates in digests or on your calendar."
          footer={<><Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Keep watching</Button><Button type="button" onClick={() => setDialogOpen(false)}>Stop watching</Button></>}
        >
          <Checkbox id="gallery-dialog-confirm" label="Also remove its preparation milestones" />
        </Dialog>
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Role evidence"
          tabs={[
            { id: "history", label: "History", content: <p className="text-xs text-ink-muted">Opening events by cycle, with each event&apos;s precision.</p> },
            { id: "sources", label: "Sources", content: <p className="text-xs text-ink-muted">Where each observation came from.</p> },
            { id: "signals", label: "Signals", content: <p className="text-xs text-ink-muted">Supporting signals carry no date weight.</p> },
          ]}
        />
      </Section>

      <Section title="Date range">
        <DateRangeField legend="Opening window" startName="from" endName="to" min="2020-01-01" max="2030-12-31" description="Either end may be left open." />
      </Section>

      <Section title="Skeleton and empty state">
        <div className="grid gap-4 sm:grid-cols-2">
          <LoadingRegion label="Loading forecasts">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-2 h-4 w-1/2" />
            <Skeleton className="mt-4 h-16 w-full" />
          </LoadingRegion>
          <div className="panel">
            <EmptyState
              title="No programs match these filters"
              description="3 roles are hidden by the track filter. Clear it to see them."
              action={<Button type="button" variant="outline" size="sm">Clear track filter</Button>}
            />
          </div>
        </div>
      </Section>

      <Section title="Evidence classes and date kinds">
        <div className="flex flex-wrap gap-2 text-micro font-semibold">
          <span className="rounded-control border px-2 py-1 evidence-exact">Exact</span>
          <span className="rounded-control border px-2 py-1 evidence-bounded">Bounded</span>
          <span className="rounded-control border px-2 py-1 evidence-observed">Observed by</span>
          <span className="rounded-control border px-2 py-1 date-confirmed">Confirmed opening</span>
          <span className="rounded-control border px-2 py-1 date-predicted">Predicted opening</span>
          <span className="rounded-control border px-2 py-1 date-preparation">Preparation milestone</span>
        </div>
      </Section>
    </main>
  );
}
