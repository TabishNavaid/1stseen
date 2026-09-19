import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignSystemGallery } from "@/components/design-system-gallery";
import { hasServiceRoleConfig } from "@/lib/real-data";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Every UI primitive, rendered for keyboard and screen-reader verification.
 *
 * Development only, under the same gate as fixture data: `FIRSTSEEN_DEMO_MODE=true` and no database configured.
 * Everywhere else it is a 404, so it can never appear in a deployment.
 */
export default function DesignSystemPage() {
  if (process.env.FIRSTSEEN_DEMO_MODE !== "true" || hasServiceRoleConfig()) notFound();
  return <DesignSystemGallery />;
}
