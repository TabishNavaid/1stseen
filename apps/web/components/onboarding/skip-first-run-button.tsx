"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Skip the first run. The skip is saved so the dashboard stops offering it; if saving fails, the dashboard is still one
 * link away, because skipping must never be the thing that blocks someone.
 */
export function SkipFirstRunButton({ label = "Skip for now" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function skip() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "skip" }),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect?: string };
      if (!response.ok) {
        throw new Error(response.status === 401 ? "Your session has ended, so the skip was not saved." : "The skip was not saved.");
      }
      router.replace(body.redirect ?? "/roles");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The skip was not saved.");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1">
      <Button type="button" variant="ghost" onClick={() => void skip()} disabled={busy}>
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-caption text-danger-ink">
          {error} <Link href="/roles" className="link-accent focus-ring">Browse programs</Link>
        </p>
      )}
    </div>
  );
}
