import type { ReactNode } from "react";
import { SiteHeaderBar } from "@/components/site-header-bar";
import type { NavKey } from "@/lib/site-nav";
import { currentSession } from "@/lib/session";

/**
 * The header of every app page (roles, a role, calendar, replay, digests). It reads the session itself, so a page
 * only says which item is current and what its own action is; a guest sees the items that need an account locked.
 */
export async function SiteHeader({
  active = null,
  status,
  actions,
  contentId,
}: {
  active?: NavKey | null;
  status?: ReactNode;
  actions?: ReactNode;
  contentId: string;
}) {
  const session = await currentSession();
  return <SiteHeaderBar active={active} signedIn={session !== null} email={session?.email ?? null} status={status} actions={actions} contentId={contentId} />;
}
