import { cn } from "@/lib/utils";
import { ICON_SPRITE_VERSION, type IconName } from "./icon-names";

export type { IconName } from "./icon-names";

/**
 * One icon from /icons.svg (scripts/build-icon-sprite.mjs). A reference costs about 130 bytes of markup where
 * an inline lucide icon cost 300 to 700.
 *
 * Decorative by default and hidden from assistive technology. Pass `label` only when the icon alone carries
 * meaning; it is then announced as an image with that name. An icon-only button names the button instead.
 */
export function Icon({
  name,
  size = 16,
  className,
  label,
  strokeWidth,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      className={cn("icon", className)}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      style={strokeWidth ? { strokeWidth } : undefined}
    >
      <use href={`/icons.svg?v=${ICON_SPRITE_VERSION}#${name}`} />
    </svg>
  );
}
