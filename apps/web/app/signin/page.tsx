import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell, AuthUnavailable } from "@/components/auth/auth-shell";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { safeReturnTo } from "@/lib/auth/policy";
import { hasSupabaseConfig } from "@/lib/config";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to keep a watchlist, readiness milestones, and recruiting calendar.",
};

export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(first(params.return_to));
  if (await currentSession()) redirect(returnTo);

  return (
    <AuthShell eyebrow="Your recruiting workspace">
      {hasSupabaseConfig()
        ? <SignInPanel returnTo={returnTo} initialMode={first(params.mode) === "sign_up" ? "sign_up" : "sign_in"} />
        : <><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Sign in</h1><AuthUnavailable /></>}
    </AuthShell>
  );
}
