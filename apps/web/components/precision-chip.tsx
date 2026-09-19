import { Icon } from "@/components/ui/icon";
import { PRECISION, type PrecisionVariant } from "@/lib/precision";
import type { DatePrecision } from "@/lib/role-view";

/**
 * How a date's evidence class is shown, everywhere it is shown.
 *
 * `exact`, `bounded` and `observed_by` are different kinds of knowledge, never levels of one quality,
 * so each keeps its own label, border style and colour and they are never
 * blurred together. Before this there were four copies of that mapping — the role page, the landing section,
 * the help dialog and Forecast Replay — each free to drift.
 *
 * The variants are the three shapes those surfaces need:
 *   `chip`  a labelled chip, with the class icon (the role page's cycles and provenance)
 *   `plain` the same chip without an icon, for long lists and dense rows
 *   `code`  a small monospace badge, lowercase, for Forecast Replay's candidate table
 */
export function PrecisionChip({
  precision,
  variant = "chip",
  children,
}: {
  precision: DatePrecision;
  variant?: PrecisionVariant;
  children?: React.ReactNode;
}) {
  const presentation = PRECISION[precision];
  if (variant === "code") {
    return (
      <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-micro font-semibold ${presentation.className}`}>
        {presentation.code}
      </span>
    );
  }
  // The icon is a child only when there is one: `{cond && <Icon/>}` would put a `false` in the RSC
  // payload of every chip without one, which is 60 of them on the largest role page.
  const label = children ?? presentation.label;
  if (variant === "plain") {
    return <span className={`inline-flex items-center rounded-chip border px-2 py-0.5 text-micro font-semibold ${presentation.className}`}>{label}</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-micro font-semibold ${presentation.className}`}>
      <Icon name={presentation.icon} size={11} />{label}
    </span>
  );
}
