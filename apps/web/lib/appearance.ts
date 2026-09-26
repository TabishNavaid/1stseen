/**
 * Light and dark, and the one control that chooses between them.
 *
 * The page itself needs no script. Every colour in globals.css is `light-dark(light, dark)` and `:root` declares
 * `color-scheme: light dark`, so a reader whose system is set to dark is served a dark page in the first byte.
 * Script is only for the reader who wants the other one: that choice is kept in this browser and written onto the
 * document as `data-theme`, which is what the two `color-scheme` overrides key off.
 *
 * It is kept in localStorage rather than a cookie deliberately. A cookie travels with every request, and the guest
 * edge cache keeps one copy of a page for everyone signed out — so a theme in a cookie would be a parameter the
 * route renders differently for, and the cache key would have to name it or one reader would be served another's
 * theme (cloudflare/guest-cache.ts, and the table that guards it). Keeping it in the browser leaves the HTML
 * identical for every reader, and the document still has the right theme before the first paint.
 */

export const APPEARANCE_STORAGE_KEY = "1stseen.appearance";

export const APPEARANCES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;

export type Appearance = (typeof APPEARANCES)[number][0];

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && APPEARANCES.some(([name]) => name === value);
}

/**
 * The stored choice, put on the document. "System" is the absence of a choice, so it takes the attribute off and
 * leaves `color-scheme: light dark` to follow the reader's own setting.
 */
export function applyAppearance(appearance: Appearance, root: HTMLElement): void {
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
}

/**
 * The same thing again, small enough to run in <head> before anything is painted. Written out rather than imported
 * because it has to be inline: a held theme has to be on the document by the first paint, not applied after one.
 */
export const APPEARANCE_SCRIPT =
  `try{var a=localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)});`
  + `if(a==="light"||a==="dark")document.documentElement.dataset.theme=a}catch(e){}`;
