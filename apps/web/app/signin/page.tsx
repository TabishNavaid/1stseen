import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell, AuthUnavailable } from "@/components/auth/auth-shell";
import { Doodle } from "@/components/doodle";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { safeReturnTo } from "@/lib/auth/policy";
import { hasSupabaseConfig } from "@/lib/config";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to keep your watchlist, calendar, and prep plans.",
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
    <AuthShell aside={<Doodle name="sitting" size="hero" />}>
      {hasSupabaseConfig()
        ? <SignInPanel returnTo={returnTo} initialMode={first(params.mode) === "sign_up" ? "sign_up" : "sign_in"} />
        : <><h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Sign in</h1><AuthUnavailable /></>}
    </AuthShell>
  );
}
