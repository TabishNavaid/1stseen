import type { Metadata } from "next";
import { AuthShell, AuthUnavailable } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { hasSupabaseConfig } from "@/lib/config";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      {hasSupabaseConfig() ? <ForgotPasswordForm /> : <><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Reset your password</h1><AuthUnavailable /></>}
    </AuthShell>
  );
}
