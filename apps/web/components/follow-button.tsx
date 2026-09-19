"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

/**
 * Explicit canonical-role follow.
 *
 * All state lives in `watchlist_items` behind `/api/personalization`, the same
 * contract `personalization.py` owns. There is no separate client-side
 * preference store, and a signed-out visitor is sent to sign in rather than
 * given a local pretend-follow.
 */
export function FollowButton({
  roleId,
  followed,
  itemId,
  disabled = false,
  compact = false,
}: {
  roleId: string;
  followed: boolean | null;
  itemId: string | null;
  disabled?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<{ following: boolean; itemId: string | null }>({
    following: followed === true,
    itemId,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (disabled) {
    return (
      <Button variant="outline" size={compact ? "sm" : "sm"} disabled title="Fixture roles cannot be followed">
        <Icon name="bell" size={13} />Watch role
      </Button>
    );
  }

  if (followed === null) {
    return (
      <a
        href={`/signin?mode=sign_up&return_to=${encodeURIComponent(`/roles/${roleId}`)}`}
        className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch"
      >
        <Icon name="bell" size={13} /><span className="sm:hidden">Sign up to watch</span><span className="hidden sm:inline">Create an account to watch</span>
      </a>
    );
  }

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const response = state.following && state.itemId
        ? await fetch("/api/personalization", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "unfollow", item_id: state.itemId }),
          })
        : await fetch("/api/personalization", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "follow",
              target: { target_type: "canonical_role", canonical_role_id: roleId, alerts_enabled: true },
            }),
          });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(response.status === 401 ? "Sign in again to change your watchlist." : body.error ?? "Watchlist update failed.");
      }
      if (state.following) {
        setState({ following: false, itemId: null });
      } else {
        const saved = await response.json() as { id?: string };
        setState({ following: true, itemId: saved.id ?? null });
      }
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Watchlist update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <Button
        variant={state.following ? "outline" : "default"}
        size="sm"
        onClick={() => void toggle()}
        disabled={busy}
        className={state.following ? "gap-1.5 bg-surface-selected" : "gap-1.5"}
        aria-pressed={state.following}
      >
        {busy ? <Icon name="loader-circle" size={13} className="animate-spin" /> : state.following ? <Icon name="bell-off" size={13} /> : <Icon name="bell" size={13} />}
        {state.following ? "Watching" : "Watch role"}
      </Button>
      {error && <span role="alert" className="mt-1 max-w-[220px] text-right text-micro text-warning-ink">{error}</span>}
    </span>
  );
}
