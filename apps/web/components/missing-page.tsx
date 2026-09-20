import Link from "next/link";
import { IllustratedMessage, primaryActionClass, quietLinkClass } from "@/components/illustrated-message";

/**
 * The not-found page, in two forms: an address that is not a page, and a program 1stSeen no longer tracks, which offers
 * the company's other programs when the company still has some. The bird is confused on both, which is the
 * message before the words arrive.
 *
 * The `data-page-status` attribute is how the Worker entry answers 404 (cloudflare/page-status.ts): the page shell has
 * already been sent by the time this renders, so the page cannot set its own status.
 */
export function MissingPage({
  variant = "page",
  company = null,
}: {
  variant?: "page" | "program";
  company?: { id: string; name: string } | null;
}) {
  const program = variant === "program";
  return (
    <main id="missing-content" className="flex flex-1 items-center justify-center bg-canvas px-4 py-12 md:py-16" data-page-status="404">
      {program ? (
        <IllustratedMessage
          titleId="missing-title"
          title="This program isn’t tracked anymore."
          text="It may have closed, changed its name, or moved outside the roles 1stSeen follows."
          primary={
            company
              ? <Link href={`/roles?company=${company.id}`} className={primaryActionClass}>See other roles at {company.name}</Link>
              : <Link href="/roles" className={primaryActionClass}>Browse all programs</Link>
          }
          secondary={company ? <Link href="/roles" className={quietLinkClass}>or browse all programs</Link> : <Link href="/" className={quietLinkClass}>or go home</Link>}
        />
      ) : (
        <IllustratedMessage
          titleId="missing-title"
          title="This page hasn’t opened yet."
          text="The bird has looked everywhere. No sign of it."
          primary={<Link href="/" className={primaryActionClass}>Take me home</Link>}
          secondary={<Link href="/roles" className={quietLinkClass}>or browse all programs</Link>}
        />
      )}
    </main>
  );
}
