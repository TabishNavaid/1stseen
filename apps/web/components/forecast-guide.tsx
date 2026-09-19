"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/overlay";
import Link from "next/link";
import { CONFIDENCE_MEANING } from "@/lib/confidence";
import { BASIS, BASIS_ORDER } from "@/lib/forecast-basis";
import { PRECISION, PRECISION_ORDER } from "@/lib/precision";
import type { DatePrecision } from "@/lib/role-view";

/** What each class means, in the guide's words. Its label and colour come from `lib/precision`. */
const MEANING: Record<DatePrecision, string> = {
  exact: "The job board supplied the publication date.",
  bounded: "Two archive captures bracket it: absent in the earlier one, present in the later one.",
  observed_by: "Visible by that date. It may have opened earlier.",
};
const CLASSES = PRECISION_ORDER.map((precision) => ({ ...PRECISION[precision], meaning: MEANING[precision] }));

/** "How to read a forecast", behind the dashboard's help button: what a window, a confidence score, and each evidence class mean. */
export function ForecastGuide() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="How to read a forecast" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="circle-help" size={16} />
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="How to read a forecast"
        description="Every date on 1stSeen says how it is known."
        footer={<Button type="button" onClick={() => setOpen(false)}>Got it</Button>}
      >
        <dl className="space-y-4 text-xs leading-5">
          <div>
            <dt className="font-semibold text-ink">Predicted window</dt>
            <dd className="mt-0.5 text-ink-muted">The 80% prediction interval the statistical model expects a program&apos;s next opening in, estimated from its past openings, with an expected date inside it.</dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Confidence score</dt>
            <dd className="mt-0.5 text-ink-muted">{CONFIDENCE_MEANING}</dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">What a window rests on</dt>
            <dd className="mt-1.5">
              <ul className="space-y-2">
                {BASIS_ORDER.map((kind) => (
                  <li key={kind} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3">
                    <span className={`inline-flex justify-self-start rounded-chip border px-2 py-0.5 text-micro font-semibold ${BASIS[kind].className}`}>{BASIS[kind].label}</span>
                    <span className="text-ink-muted">{BASIS[kind].meaning}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-ink-subtle">The percentage is that basis&apos;s share of the window&apos;s weight, as the model recorded it.</p>
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">Evidence classes</dt>
            <dd className="mt-1.5">
              <ul className="space-y-2">
                {CLASSES.map((item) => (
                  <li key={item.label} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3">
                    <span className={`inline-flex justify-self-start rounded-chip border px-2 py-0.5 text-micro font-semibold ${item.className}`}>{item.label}</span>
                    <span className="text-ink-muted">{item.meaning}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-ink-subtle">The three are stored apart and never promoted into one another.</p>
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink">No forecast yet</dt>
            <dd className="mt-0.5 text-ink-muted">A program gets a window once the model can compute one: from three recruiting cycles of its own, or from fewer when a comparable program (the same level and season) has timing to borrow. Until then its evidence is listed without a date.</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-5 text-ink-muted">
          <Link href="/methodology" className="link-accent focus-ring">How forecasts are made, and how accurate they are</Link>
        </p>
      </Dialog>
    </>
  );
}
