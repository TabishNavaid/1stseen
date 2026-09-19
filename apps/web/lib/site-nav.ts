/**
 * The app's navigation: one list, so the header, its phone menu, and the tests agree on what a guest can open and
 * why the rest asks for an account.
 *
 * A guest sees every item. One that needs an account carries a lock and a single line saying what signing in gives;
 * it still links to its page, which explains itself to a guest rather than failing.
 *
 * Kept free of React so the tests read it directly.
 */

import type { IconName } from "@/components/ui/icon-names";

export type NavKey = "explore" | "watchlist" | "calendar" | "replay" | "digests";

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  icon: IconName;
  /** Null when a guest can use the page fully; otherwise the one line a guest reads beside the lock. */
  lockedReason: string | null;
};

export const SITE_NAV: readonly NavItem[] = [
  { key: "explore", label: "Explore", href: "/roles", icon: "radar", lockedReason: null },
  { key: "watchlist", label: "Watchlist", href: "/roles?watched=1", icon: "bell", lockedReason: "Sign in to save roles and get alerts" },
  { key: "calendar", label: "Calendar", href: "/calendar", icon: "calendar-days", lockedReason: "Sign in to plan around the roles you watch" },
  { key: "replay", label: "Replay", href: "/replay", icon: "calendar-clock", lockedReason: "Sign in to replay a past forecast" },
  { key: "digests", label: "Digests", href: "/digests", icon: "mail", lockedReason: "Sign in to get a weekly email of changes" },
];

/** Whether an item is locked for this visitor. */
export function navLocked(item: NavItem, signedIn: boolean): boolean {
  return !signedIn && item.lockedReason !== null;
}
