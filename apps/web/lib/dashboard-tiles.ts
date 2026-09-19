/**
 * The roles view's "at a glance" counts, decided without React so the rule is pinned by tests.
 *
 * A tile is shown only when its number is not zero: "0 likely in 30 days" beside an empty panel read as a broken page.
 * The watched tile needs an account, so a guest never sees it. Every number here is one the loader counted from the
 * same records the page lists (lib/dashboard-query.ts); nothing is invented to fill a tile.
 */

export type DashboardTile = { key: "soon" | "watched" | "opened"; value: number };

export function dashboardTiles(counts: {
  openingWithin30Days: number;
  followedRoles: number;
  confirmedOpenings: number;
  signedIn: boolean;
}): DashboardTile[] {
  const tiles: DashboardTile[] = [
    { key: "soon", value: counts.openingWithin30Days },
    { key: "watched", value: counts.signedIn ? counts.followedRoles : 0 },
    { key: "opened", value: counts.confirmedOpenings },
  ];
  return tiles.filter((tile) => tile.value > 0);
}
