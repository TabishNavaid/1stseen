import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's own scale, so it would read the design tokens' `text-micro` and `text-caption`
 * as colours and drop them beside a `text-ink`. Declaring them as font sizes keeps both, and the radius and shadow
 * tokens resolve against the defaults they replace.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "caption"] }],
      rounded: [{ rounded: ["control", "panel", "card", "overlay", "chip"] }],
      shadow: [{ shadow: ["raised", "card", "lift", "popover", "dialog"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
