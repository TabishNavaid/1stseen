import Link from "next/link";
import { sitePage } from "@/lib/site-links";

/**
 * How the policy pages point at the contact address: the configured address itself (FIRSTSEEN_CONTACT_EMAIL, read by the
 * page through `getContactEmail`), or, when this deployment has none, the contact page, which says so plainly.
 */
export function ContactAddress({ email }: { email: string | null }) {
  if (email) {
    return <a href={`mailto:${email}`} className="link-accent focus-ring">{email}</a>;
  }
  return <Link href={sitePage("contact").href} className="link-accent focus-ring">the address on the contact page</Link>;
}
