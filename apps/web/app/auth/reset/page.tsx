import type { Metadata } from "next";
import { AuthShell, AuthUnavailable } from "@/components/auth/auth-shell";
import { ResetPasswordFlow } from "@/components/auth/reset-password-flow";
import { hasSupabaseConfig } from "@/lib/config";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  if (!hasSupabaseConfig()) {
    return <AuthShell><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Choose a new password</h1><AuthUnavailable /></AuthShell>;
  }
  return (
    <AuthShell>
      <ResetPasswordFlow hasSession={Boolean(await currentSession())} />
    </AuthShell>
  );
}
