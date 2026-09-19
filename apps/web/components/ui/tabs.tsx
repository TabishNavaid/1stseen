"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { dateRangeMessage, dateRangeProblem } from "@/lib/ui/date-range";
import { nextIndex, type NavigationKey } from "@/lib/ui/listbox";
import { cn } from "@/lib/utils";

export type TabItem = { id: string; label: ReactNode; content: ReactNode };

/**
 * Tabs: the ARIA tabs pattern with automatic activation.
 *
 * Only the selected tab is in the tab order. ArrowLeft and ArrowRight move between tabs and wrap, Home and End go
 * to the first and last, and the panel follows the focused tab. Each panel is labelled by its tab and can take
 * focus, so Tab from the tab list reaches the panel's content.
 */
export function Tabs({ label, tabs, defaultTabId, className }: { label: string; tabs: readonly TabItem[]; defaultTabId?: string; className?: string }) {
  const id = useId();
  const [selectedId, setSelectedId] = useState(defaultTabId ?? tabs[0]?.id);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, tabs.findIndex((tab) => tab.id === selectedId));

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = nextIndex(selected, event.key as NavigationKey, tabs.length, true);
    if (next < 0) return;
    setSelectedId(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === selected}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === selected ? 0 : -1}
            onClick={() => setSelectedId(tab.id)}
            onKeyDown={onKeyDown}
            className={cn(
              "focus-ring -mb-px h-control shrink-0 border-b-2 px-3 text-xs font-semibold",
              index === selected ? "border-accent text-ink" : "border-transparent text-ink-subtle hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div key={tab.id} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} tabIndex={0} hidden={index !== selected} className="focus-ring pt-4">
          {tab.content}
        </div>
      ))}
    </div>
  );
}

/**
 * A date range as two labelled native date inputs in a fieldset whose legend names the range.
 *
 * Native inputs keep the platform's keyboard entry and picker, and submit with a GET form. Each end limits the
 * other (the end cannot be picked before the start). A problem is written out as text, tied to both inputs with
 * aria-describedby, marked with aria-invalid, and announced politely when it appears.
 */
export function DateRangeField({
  legend,
  startName,
  endName,
  startLabel = "From",
  endLabel = "To",
  defaultStart = "",
  defaultEnd = "",
  min,
  max,
  description,
  onRangeChange,
  className,
}: {
  legend: string;
  startName: string;
  endName: string;
  startLabel?: string;
  endLabel?: string;
  defaultStart?: string;
  defaultEnd?: string;
  min?: string;
  max?: string;
  description?: string;
  onRangeChange?: (range: { start: string; end: string }) => void;
  className?: string;
}) {
  const id = useId();
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const problem = dateRangeProblem(start, end, { min, max });
  const descriptionId = description ? `${id}-description` : undefined;
  const messageId = `${id}-message`;
  const describedBy = [descriptionId, problem ? messageId : undefined].filter(Boolean).join(" ") || undefined;
  const startInvalid = problem !== null && problem !== "end_invalid";
  const endInvalid = problem !== null && problem !== "start_invalid";

  const update = (nextStart: string, nextEnd: string) => {
    setStart(nextStart);
    setEnd(nextEnd);
    onRangeChange?.({ start: nextStart, end: nextEnd });
  };

  return (
    <fieldset className={cn("m-0 grid gap-1.5 border-0 p-0", className)}>
      <legend className="label-caps mb-1 p-0 text-ink-subtle">{legend}</legend>
      {description && <p id={descriptionId} className="text-caption text-ink-subtle">{description}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor={`${id}-start`} className="text-caption font-medium text-ink-muted">{startLabel}</label>
          <input
            id={`${id}-start`}
            type="date"
            name={startName}
            value={start}
            min={min}
            max={end || max}
            aria-describedby={describedBy}
            aria-invalid={startInvalid || undefined}
            onChange={(event) => update(event.target.value, end)}
            className="control px-3"
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-end`} className="text-caption font-medium text-ink-muted">{endLabel}</label>
          <input
            id={`${id}-end`}
            type="date"
            name={endName}
            value={end}
            min={start || min}
            max={max}
            aria-describedby={describedBy}
            aria-invalid={endInvalid || undefined}
            onChange={(event) => update(start, event.target.value)}
            className="control px-3"
          />
        </div>
      </div>
      <p id={messageId} aria-live="polite" className="text-caption font-semibold text-danger-ink">
        {problem ? dateRangeMessage(problem, { min, max }) : ""}
      </p>
    </fieldset>
  );
}
