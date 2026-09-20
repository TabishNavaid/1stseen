import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/**
 * One line about a program on the reader's watchlist whose window moved this week.
 *
 * It says what changed in the reader's own terms and shows the window before and after. The score behind the change
 * and the reason code the detector crossed are the machine's account of itself and are not written here at all
 * (lib/forecast-change-notes.ts).
 */
export type ForecastChangeView = {
  id: string;
  roleId: string;
  company: string;
  program: string;
  previousWindow: string;
  currentWindow: string;
  changedAt: string;
  notes: string[];
};

export function ForecastChange({ change }: { change: ForecastChangeView }) {
  return (
    <article className="border-b border-line py-4 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold text-ink">
          <Link href={`/roles/${change.roleId}`} className="focus-ring rounded-sm hover:underline">
            <span className="font-normal text-ink-muted">{change.company}</span> {change.program}
          </Link>
        </p>
        <p className="text-micro text-ink-subtle">{change.changedAt}</p>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-caption font-semibold text-accent-ink">
        <Icon name="arrow-right" size={12} className="shrink-0" />
        {change.notes.join(" · ")}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-caption tabular">
        <span className="text-ink-subtle line-through">{change.previousWindow}</span>
        <Icon name="arrow-right" size={12} className="text-ink-subtle" />
        <span className="font-semibold text-ink">{change.currentWindow}</span>
      </p>
    </article>
  );
}
