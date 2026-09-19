"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { RESEND_COOLDOWN_SECONDS } from "@/lib/auth/policy";
import { secondaryButtonClass } from "@/components/auth/fields";

/**
 * Resend with a cooldown. The cooldown starts when the panel appears, because an email was
 * just requested. The countdown is visual; the live region only announces the two moments
 * that matter (sent again, and available again), so screen readers are not flooded.
 */
export function ResendButton({ endpoint, email }: { endpoint: string; email: string }) {
  const [remaining, setRemaining] = useState(RESEND_COOLDOWN_SECONDS);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setRemaining((value) => value - 1);
      if (remaining === 1) setAnnouncement("You can send the email again now.");
    }, 1_000);
    return () => clearTimeout(timer);
  }, [remaining]);

  async function resend() {
    setBusy(true);
    setAnnouncement("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setAnnouncement(response.status === 202 ? "Sent again. It can take a minute to arrive." : "The email could not be sent. Try again in a moment.");
    } catch {
      setAnnouncement("The email could not be sent. Try again in a moment.");
    } finally {
      setBusy(false);
      setRemaining(RESEND_COOLDOWN_SECONDS);
    }
  }

  return (
    <div>
      <button type="button" onClick={() => void resend()} disabled={busy || remaining > 0} className={secondaryButtonClass}>
        {busy ? <Icon name="loader-circle" size={15} className="animate-spin" /> : <Icon name="rotate-cw" size={15} />}
        {remaining > 0 ? `Send again in ${remaining} s` : "Send the email again"}
      </button>
      <p className="mt-2 min-h-5 text-xs leading-5 text-success-ink" aria-live="polite">{announcement}</p>
    </div>
  );
}
