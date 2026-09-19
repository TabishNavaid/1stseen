"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";

export function SignOutButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/sign-out", { method: "POST" }).catch(() => null);
        router.replace("/");
        router.refresh();
      }}
      className={`inline-flex items-center gap-1.5 rounded-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-accent ${className}`}
    >
      <Icon name="log-out" size={13} />{busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
