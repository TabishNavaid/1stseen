import type { ReactNode } from "react";
import { FocusedShell } from "@/components/focused-shell";
import { Icon } from "@/components/ui/icon";

/**
 * Shared frame for the sign-in, confirmation, and password pages: the focused shell the first run and settings use.
 *
 * `aside` is the character that sits beside the form from `lg` up, where there is room either side of a 480px column.
 * It is decoration and is not drawn at all on a narrower screen, where the form itself should reach the fold.
 */
export function AuthShell({ eyebrow, aside, children }: { eyebrow: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <FocusedShell width="narrow" aside={aside}>
      <p className="label-caps text-accent-ink">{eyebrow}</p>
      {children}
      <p className="mt-6 flex gap-2 text-xs leading-5 text-ink-muted">
        <Icon name="shield-check" size={14} className="mt-0.5" />
        Your watchlist, plans, calendar, and digests are private to your account. Your session cookie cannot be read by page scripts.
      </p>
    </FocusedShell>
  );
}

export function AuthUnavailable() {
  return (
    <div className="panel mt-6 p-5">
      <p className="text-sm leading-6 text-warning-ink">
        Supabase authentication is not configured for this deployment. Set
        <code className="mx-1 font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and
        <code className="mx-1 font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to enable sign-in.
      </p>
    </div>
  );
}
