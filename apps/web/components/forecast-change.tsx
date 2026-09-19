import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { Icon } from "@/components/ui/icon";
import type { ForecastBasis } from "@/lib/forecast-basis";

export type ForecastChangeView = {
  previousWindow: string;
  currentWindow: string;
  confidenceDelta: number;
  changedAt: string;
  reason: string;
  /** The basis of the forecast it changed to. */
  basis?: ForecastBasis | null;
};

export function ForecastChange({ change, roleName }: { change: ForecastChangeView; roleName: string }) {
  return (
    <article className="border-b border-line py-4 last:border-0">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-ink">{roleName}</p><p className="mt-1 text-micro text-ink-subtle">Updated {change.changedAt}</p></div><span className="flex items-center gap-1 text-caption font-semibold text-accent-ink"><Icon name="trending-up" size={13} />{change.confidenceDelta >= 0 ? "+" : ""}{change.confidenceDelta} pts</span></div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-caption tabular"><span className="text-ink-subtle line-through">{change.previousWindow}</span><Icon name="arrow-right" size={12} className="text-ink-subtle" /><span className="font-semibold text-ink">{change.currentWindow}</span>{change.basis && <ForecastBasisChip basis={change.basis} variant="plain" />}</div>
      <p className="mt-2 text-caption leading-5 text-ink-subtle">{change.reason}</p>
    </article>
  );
}
