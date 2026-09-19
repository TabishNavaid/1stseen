"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server render and until React hydrates; true after. Auth submit buttons stay
 * disabled until then, and a form whose default button is disabled cannot be submitted by
 * pressing Enter, so a form can never fall back to a native submission before its handler
 * exists.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
