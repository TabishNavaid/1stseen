/**
 * The one definition of how each date-evidence class is named and coloured.
 *
 * `exact`, `bounded` and `observed_by` are different kinds of knowledge, not levels of one quality, and must
 * never be blurred into each other. The label, the utility
 * class, and the icon therefore live here rather than being retyped on each surface: four copies of this
 * mapping existed before, one per surface, and any of them could have drifted on its own.
 *
 * The prose meanings stay with the surfaces that show them, because they are written for their context — a
 * landing bullet, a help dialog, a chip's caption — but they all describe these three classes and no others.
 *
 * Kept free of React so it can be read by tests under `node --experimental-strip-types`.
 */

import type { IconName } from "@/components/ui/icon-names";
import type { DatePrecision } from "@/lib/role-view";

/** `chip` carries the class icon; `plain` is the same chip in dense lists; `code` is Replay's mono badge. */
export type PrecisionVariant = "chip" | "plain" | "code";

export const PRECISION: Record<DatePrecision, { label: string; code: string; icon: IconName; className: string }> = {
  exact: { label: "Exact", code: "exact", icon: "circle-check", className: "evidence-exact" },
  bounded: { label: "Bounded", code: "bounded", icon: "circle-dashed", className: "evidence-bounded" },
  observed_by: { label: "Observed by", code: "observed by", icon: "clock-3", className: "evidence-observed" },
};

export const PRECISION_ORDER: readonly DatePrecision[] = ["exact", "bounded", "observed_by"];
