"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

/**
 * Materialise the deterministic work-back plan for a followed role.
 *
 * The button only asks the worker to run the versioned readiness policy over
 * the stored forecast. No date is calculated in the browser.
 */
export function GenerateReadinessButton({ roleId }: { roleId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/readiness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role_id: roleId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; reason?: string };
      if (!response.ok) {
        throw new Error(
          body.reason
            ?? (body.error === "readiness_api_unavailable"
              ? "The readiness worker is not configured for this deployment."
              : body.error === "readiness_api_unreachable"
                ? "The readiness worker is configured but not responding. Try again in a moment."
              : body.error === "role_not_followed"
                ? "Follow this role before generating a preparation plan."
                : "The preparation plan could not be generated."),
        );
      }
      router.refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "The preparation plan could not be generated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line p-4">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void generate()} className="w-full gap-1.5">
        {busy ? <Icon name="loader-circle" size={13} className="animate-spin" /> : <Icon name="calendar-plus" size={13} />}
        Generate preparation plan
      </Button>
      {message && <p role="status" className="mt-2 text-micro text-warning-ink">{message}</p>}
    </div>
  );
}
