"use client";

import { useEffect, useId, useState } from "react";
import { APPEARANCES, APPEARANCE_STORAGE_KEY, applyAppearance, isAppearance, type Appearance } from "@/lib/appearance";
import { cn } from "@/lib/utils";

/**
 * Which theme this browser draws the site in: the reader's system setting, or one of the two held.
 *
 * Three radios rather than a switch, because "follow my system" is a real answer and not the absence of one, and
 * because radios say what is chosen without script having to describe it. The choice belongs to this browser
 * (lib/appearance.ts), so nothing is sent anywhere and a signed-out reader has it too.
 *
 * It renders as "System" until the effect reads what is stored: a server has no browser to ask, and guessing in the
 * markup would be a hydration mismatch. The page is already in the right theme by then — the script in <head> put it
 * there — so what settles here is which of the three reads as chosen, not what the reader is looking at.
 */
export function AppearanceControl({ className }: { className?: string }) {
  const [choice, setChoice] = useState<Appearance>("system");
  const name = useId();

  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
        setChoice(isAppearance(stored) ? stored : "system");
      } catch {
        // A browser that refuses storage still gets its system setting, which is the default here.
      }
    };
    read();
    // Two tabs of the same site agree: the one that did not make the change hears about it.
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEY) read();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    applyAppearance(choice, document.documentElement);
  }, [choice]);

  const pick = (next: Appearance) => {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(APPEARANCE_STORAGE_KEY);
      else localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
    } catch {
      // The theme still changes for this visit; it is simply not remembered for the next one.
    }
  };

  return (
    <fieldset className={cn("m-0 border-0 p-0", className)}>
      <legend className="label-caps float-left mr-2 p-0 leading-5 text-ink-subtle">Appearance</legend>
      <div className="flex items-center gap-0.5 rounded-chip border border-line p-0.5">
        {APPEARANCES.map(([value, label]) => (
          <label
            key={value}
            className={cn(
              "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus cursor-pointer rounded-chip px-2.5 py-1 text-caption font-semibold transition-colors",
              choice === value ? "bg-accent-soft text-accent-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={choice === value}
              onChange={() => pick(value)}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
