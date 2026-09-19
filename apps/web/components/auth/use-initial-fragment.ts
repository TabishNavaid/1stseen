"use client";

import { useSyncExternalStore } from "react";

let captured: string | null = null;
let capturedSearch: string | null = null;
const subscribe = () => () => {};
const readOnce = () => (captured ??= window.location.hash);
const readSearchOnce = () => (capturedSearch ??= window.location.search);

/**
 * The URL fragment as it was when this page loaded. The server render sees null (a fragment
 * never reaches a server); the client reads it once, so clearing it from the address bar
 * afterwards does not change what the page already read.
 */
export function useInitialFragment(): string | null {
  return useSyncExternalStore(subscribe, readOnce, () => null);
}

/** The query string as it was when this page loaded, read the same way: a redirect from Supabase may carry one. */
export function useInitialSearch(): string | null {
  return useSyncExternalStore(subscribe, readSearchOnce, () => null);
}
