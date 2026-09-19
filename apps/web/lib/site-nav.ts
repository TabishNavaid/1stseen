/**
 * The app's navigation: one list, so the header, its phone menu, and the tests agree on what each visitor sees.
 *
 * A guest sees three items: Explore, Just opened, and Ask. A signed-in user also sees their Watchlist and Calendar.
 * Forecast Replay is reached from the methodology page and email digests from settings; neither is in the navigation.
 *
 * Kept free of React so the tests read it directly.
 */

import type { IconName } from "@/components/ui/icon-names";

export type NavKey = "explore" | "opened" | "ask" | "watchlist" | "calendar";

export type NavItem = {
  key: NavKey;
  label: string;
  href: string;
  icon: IconName;
  /** Shown only to a signed-in user. */
  account: boolean;
};

export const SITE_NAV: readonly NavItem[] = [
  { key: "explore", label: "Explore", href: "/roles", icon: "radar", account: false },
  { key: "opened", label: "Just opened", href: "/opened", icon: "door-open", account: false },
  { key: "ask", label: "Ask", href: "/ask", icon: "message-circle-question-mark", account: false },
  { key: "watchlist", label: "Watchlist", href: "/roles?watched=1", icon: "bell", account: true },
  { key: "calendar", label: "Calendar", href: "/calendar", icon: "calendar-days", account: true },
];

/** The items this visitor sees, in order. */
export function navItems(signedIn: boolean): NavItem[] {
  return SITE_NAV.filter((item) => signedIn || !item.account);
}
