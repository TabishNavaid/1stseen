import type { Metadata } from "next";
import Link from "next/link";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { getContactEmail } from "@/lib/config";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Contact",
  description: "How to reach whoever runs this deployment of 1stSeen.",
};

// FIRSTSEEN_CONTACT_EMAIL is read at request time, so setting it takes effect without a rebuild.
export const dynamic = "force-dynamic";

/**
 * One page, one address: FIRSTSEEN_CONTACT_EMAIL. When the deployment sets none, the page says so plainly rather than
 * showing a placeholder. It carries no draft marker: it states only what this deployment is configured with.
 */
export default function ContactPage() {
  const email = getContactEmail();
  return (
    <DocumentPage
      eyebrow="Contact"
      title="Contact"
      lede={
        email ? (
          <p>
            Write to <a href={`mailto:${email}`} className="link-accent focus-ring font-semibold">{email}</a>. It is the one
            address for everything below.
          </p>
        ) : (
          <p>
            <strong className="text-ink">No contact address is configured on this deployment.</strong> Whoever runs it has not
            set one yet, so there is no address to write to here.
          </p>
        )
      }
    >
      <DocumentSection id="what" title="What to write about">
        <ul>
          <li>A question about 1stSeen, or a forecast that looks wrong.</li>
          <li>
            Your account, if you cannot sign in. Downloading your data and deleting your account are in{" "}
            <Link href="/settings" className="link-accent focus-ring">Settings</Link>, under Your data, and need no email.
          </li>
          <li>
            A request from a company to stop collection or to be removed.
            {email && (
              <>
                {" "}<Link href={sitePage("data-sources").href} className="link-accent focus-ring">Data sources</Link> says what
                happens, and how quickly.
              </>
            )}
          </li>
          <li>A security problem you found. Please describe it here rather than testing it against other people&apos;s accounts.</li>
        </ul>
        <p>
          The <Link href={sitePage("terms").href} className="link-accent focus-ring">terms</Link> and the{" "}
          <Link href={sitePage("privacy").href} className="link-accent focus-ring">privacy policy</Link> say what 1stSeen is and
          what it keeps.
        </p>
      </DocumentSection>
    </DocumentPage>
  );
}
