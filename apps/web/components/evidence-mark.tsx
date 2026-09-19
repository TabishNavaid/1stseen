"use client";

import { Icon } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/overlay";
import { PRECISION } from "@/lib/precision";
import type { DatePrecision } from "@/lib/role-view";

/** What each evidence class means, in the History section's words. */
export const PRECISION_MEANING: Record<DatePrecision, string> = {
  exact: "The source supplied this publication date.",
  bounded: "A complete earlier capture proved absence and a later one proved presence.",
  observed_by: "The role was visible by this date. It may have opened earlier.",
};

/**
 * A date's evidence class as a small icon with a tooltip: the class's own icon and border style, its name, and what it
 * means. Only the role page's History section shows it; everywhere else a date is described in plain words.
 */
export function EvidenceMark({ precision }: { precision: DatePrecision }) {
  const presentation = PRECISION[precision];
  return (
    <Tooltip align="start" content={<><strong className="font-semibold">{presentation.label}.</strong> {PRECISION_MEANING[precision]}</>}>
      <button type="button" className={`focus-ring relative grid size-7 shrink-0 place-items-center rounded-full border ${presentation.className} before:absolute before:-inset-2 before:content-[''] sm:before:hidden`}>
        <Icon name={presentation.icon} size={13} />
        <span className="sr-only">{presentation.label}</span>
      </button>
    </Tooltip>
  );
}
