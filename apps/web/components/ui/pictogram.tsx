import { cn } from "@/lib/utils";
import { PICTOGRAM_SPRITE_VERSION, type PictogramName } from "./pictogram-names";

export type { PictogramName } from "./pictogram-names";

/**
 * One pictogram from /pictograms.svg (apps/web/tools/build-pictograms.mjs): the larger icons of the landing page and
 * the first run. Drawn exactly like `Icon`, and decorative in the same way: the chip or step beside it carries the name.
 */
export function Pictogram({ name, size = 24, className }: { name: PictogramName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={cn("icon", className)} focusable="false" aria-hidden="true">
      <use href={`/pictograms.svg?v=${PICTOGRAM_SPRITE_VERSION}#${name}`} />
    </svg>
  );
}
