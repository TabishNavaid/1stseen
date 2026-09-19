import type { Metadata } from "next";
import { MissingPage } from "@/components/missing-page";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Page not found" };

/** Any address that is not a page. The Worker entry answers it 404 (cloudflare/page-status.ts). */
export default function NotFound() {
  return (
    <>
      <SiteHeader contentId="missing-content" />
      <MissingPage />
    </>
  );
}
