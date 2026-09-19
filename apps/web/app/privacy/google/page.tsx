import type { Metadata } from "next";
import Link from "next/link";
import { ContactAddress } from "@/components/contact-address";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { getContactEmail } from "@/lib/config";
import { LEGAL_PAGES_ARE_DRAFTS, LEGAL_PAGES_UPDATED } from "@/lib/legal";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Google data use",
  description: "The Google permissions 1stSeen asks for, exactly what it does with each, and how it meets Google's Limited Use requirements.",
};

export const dynamic = "force-dynamic";

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";

/**
 * The scopes exactly as the connect routes request them. tests/legal-pages.test.mjs reads
 * app/api/integrations/google-calendar/connect/route.ts and app/api/integrations/gmail/connect/route.ts and fails if a
 * scope requested there is missing here, so this page cannot drift from the code.
 */
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.send"] as const;

const CONTENTS = [
  { id: "limited-use", title: "Limited Use" },
  { id: "calendar", title: "Google Calendar" },
  { id: "gmail", title: "Gmail" },
  { id: "never", title: "What 1stSeen never does with Google data" },
  { id: "revoke", title: "Disconnecting, and revoking access" },
] as const;

function Scope({ value }: { value: string }) {
  return <code className="break-all rounded-sm bg-surface-sunken px-1 font-mono text-caption text-ink">{value}</code>;
}

/** The Google API Services disclosure, linked from the privacy policy and every page's footer. */
export default function GoogleDataPage() {
  const email = getContactEmail();
  return (
    <DocumentPage
      eyebrow="Privacy Policy"
      title="How 1stSeen uses Google data"
      draft={LEGAL_PAGES_ARE_DRAFTS}
      lede={
        <p>
          1stSeen can add dates to your Google Calendar and send you a digest through Gmail. Both are optional, each is
          connected separately, and neither is requested when you create an account. This page lists every permission each
          asks Google for, and exactly what 1stSeen does with it.
        </p>
      }
      updated={LEGAL_PAGES_UPDATED}
      contents={CONTENTS}
    >
      <DocumentSection id="limited-use" title="Limited Use">
        <p>
          1stSeen&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
          <a href={USER_DATA_POLICY} className="link-accent focus-ring">Google API Services User Data Policy</a>, including the
          Limited Use requirements.
        </p>
      </DocumentSection>

      <DocumentSection id="calendar" title="Google Calendar">
        <p>1stSeen asks for one permission:</p>
        <ul>
          <li>
            <Scope value={CALENDAR_SCOPE} />. Google describes it as letting an app view and edit events on all your calendars.
          </li>
        </ul>
        <p>That is broader than what 1stSeen does with it. With it, 1stSeen does exactly this, and only when you ask:</p>
        <ul>
          <li>
            For each date you tick in the calendar&apos;s sync panel, it adds an all-day event to your primary calendar. The
            event&apos;s ID is one 1stSeen makes, starting with &quot;1stseen&quot;.
          </li>
          <li>If you sync a date again after it has changed, it updates that same event instead of adding another.</li>
          <li>When you disconnect and choose to remove synced events, it deletes the events it added. Otherwise they stay.</li>
        </ul>
        <p>
          It never lists, reads, or changes any other event, and never touches another calendar. When you connect, it also asks
          Google for your primary calendar&apos;s name, to show which account is connected. This permission does not include
          that, so Google refuses it and no name is stored.
        </p>
        <p>
          Each event says what it is. A forecast event says it is a 1stSeen statistical forecast and not a confirmed company
          date, with its confidence score where there is one, and every event links back to the role&apos;s page on 1stSeen.
        </p>
      </DocumentSection>

      <DocumentSection id="gmail" title="Gmail">
        <p>1stSeen asks for three permissions, together:</p>
        <ul>
          <li>
            <Scope value={GMAIL_SCOPES[0]} /> and <Scope value={GMAIL_SCOPES[1]} />, to learn your Google account&apos;s email
            address, once, when you connect. That address is the only one a digest is ever sent to.
          </li>
          <li>
            <Scope value={GMAIL_SCOPES[2]} />, to send the digest you previewed, from your account to that same address, each
            time you tick the confirmation and press Send, where sending is turned on for this site. It can send mail only. It
            cannot read, search, or delete your mail.
          </li>
        </ul>
        <p>Connecting sends nothing, and nothing is sent on a schedule.</p>
      </DocumentSection>

      <DocumentSection id="never" title="What 1stSeen never does with Google data">
        <ul>
          <li>It uses Google data only to add your chosen dates and to send the digests you ask for.</li>
          <li>It does not sell it, use it for advertising, or use it to train any AI model.</li>
          <li>
            It transfers it to no one, except that its hosting providers store it for 1stSeen: the access tokens are stored
            encrypted, and each is bound to your account and to the service it belongs to.
          </li>
          <li>
            No person reads it, unless you ask for help and agree to it, to investigate abuse or a security problem, or where the
            law requires.
          </li>
        </ul>
        <p>
          What is stored, and for how long, is in the{" "}
          <Link href={sitePage("privacy").href} className="link-accent focus-ring">privacy policy</Link>.
        </p>
      </DocumentSection>

      <DocumentSection id="revoke" title="Disconnecting, and revoking access">
        <ul>
          <li>
            Disconnect Google Calendar from the calendar page, or Gmail from the digest page. 1stSeen asks Google to revoke its
            access and deletes the stored tokens.
          </li>
          <li>
            You can also remove 1stSeen&apos;s access yourself at any time, from your Google Account&apos;s list of third-party
            connections at <a href="https://myaccount.google.com/connections" className="link-accent focus-ring">myaccount.google.com/connections</a>.
          </li>
          <li>
            Deleting your 1stSeen account deletes both stored tokens and asks Google to revoke both. The deletion never waits
            on Google: if Google does not confirm the revocation, your account is still deleted and you are told to remove the
            access yourself at the address above.
          </li>
        </ul>
        <p>Questions about Google data go to <ContactAddress email={email} />.</p>
      </DocumentSection>
    </DocumentPage>
  );
}
