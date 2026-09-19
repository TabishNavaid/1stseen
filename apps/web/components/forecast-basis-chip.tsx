import { Icon } from "@/components/ui/icon";
import { BASIS, basisLabel, type ForecastBasis } from "@/lib/forecast-basis";

/**
 * A forecast's basis, shown the way a date's evidence class is (`precision-chip.tsx`): its own label, icon, and colour,
 * always with its share, so "rests on this program's own history" and "borrows comparable programs' timing" read apart at
 * a glance. `plain` drops the icon for dense rows.
 */
export function ForecastBasisChip({ basis, variant = "chip" }: { basis: ForecastBasis; variant?: "chip" | "plain" }) {
  const presentation = BASIS[basis.kind];
  const className = `inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-micro font-semibold tabular ${presentation.className}`;
  const text = <>{basisLabel(basis)}<span className="sr-only"> {presentation.of}</span></>;
  // Two shapes rather than `{cond && <Icon/>}`, which would put a placeholder in the RSC payload of every plain chip.
  if (variant === "plain") return <span className={className} title={presentation.meaning}>{text}</span>;
  return <span className={className} title={presentation.meaning}><Icon name={presentation.icon} size={11} />{text}</span>;
}
