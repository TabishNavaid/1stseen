import type { Metadata } from "next";
import { EmailDigestPage } from "@/components/email-digest-page";
import { loadDigestSourceData } from "@/lib/email-digests/data";
import { buildEmailDigest, type EmailDigest } from "@/lib/email-digests/digest";
import { digestFixtureSource } from "@/lib/email-digests/fixture";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Email intelligence digests",
  description: "Preview deterministic watched-role updates and explicitly send them through Gmail.",
};

// The digest is built from user-owned watchlist state.
export const dynamic = "force-dynamic";

/**
 * Real mode never seeds a fixture digest.
 *
 * When Supabase is configured the initial preview is built from the signed-in
 * user's own watchlist. A signed-out visitor sees an explicit sign-in state
 * rather than a sample email that looks like their data.
 */
export default async function DigestsPage() {
  if (hasServiceRoleConfig()) {
    const session = await currentSession();
    if (!session) return <EmailDigestPage mode="signed_out" initialDigest={null} />;
    let digest: EmailDigest | null = null;
    let error: string | null = null;
    try {
      digest = await buildEmailDigest(await loadDigestSourceData(session.userId));
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "digest_preview_failed";
    }
    return <EmailDigestPage mode="real" initialDigest={digest} loadError={error} />;
  }
  if (process.env.FIRSTSEEN_DEMO_MODE === "true") {
    return <EmailDigestPage mode="demo" initialDigest={await buildEmailDigest(digestFixtureSource)} />;
  }
  return <EmailDigestPage mode="unconfigured" initialDigest={null} />;
}
