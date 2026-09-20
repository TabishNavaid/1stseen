import type { Metadata } from "next";
import { AuthShell, AuthUnavailable } from "@/components/auth/auth-shell";
import { ConfirmEmail } from "@/components/auth/confirm-email";
import { hasSupabaseConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ConfirmPage() {
  return (
    <AuthShell>
      {hasSupabaseConfig() ? <ConfirmEmail /> : <><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Confirm your email</h1><AuthUnavailable /></>}
    </AuthShell>
  );
}
