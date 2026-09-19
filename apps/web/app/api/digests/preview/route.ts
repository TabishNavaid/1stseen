import { authenticatedUser } from "@/lib/supabase/authenticated";
import { buildEmailDigest } from "@/lib/email-digests/digest";
import { loadDigestSourceData } from "@/lib/email-digests/data";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  try {
    return Response.json(await buildEmailDigest(await loadDigestSourceData(auth.userId)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "digest_preview_failed" }, { status: 500 });
  }
}
