import type { Metadata } from "next";
import Link from "next/link";
import { ContactAddress } from "@/components/contact-address";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { getContactEmail } from "@/lib/config";
import { LEGAL_PAGES_ARE_DRAFTS, LEGAL_PAGES_UPDATED } from "@/lib/legal";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms for using 1stSeen: what it is, what a forecast is and is not, acceptable use, and ending an account.",
};

// The contact address is read at request time, so it is never fixed into a build.
export const dynamic = "force-dynamic";

const CONTENTS = [
  { id: "service", title: "What 1stSeen is" },
  { id: "forecasts", title: "A forecast is a prediction" },
  { id: "not-advice", title: "Not advice" },
  { id: "independent", title: "Not affiliated with the companies" },
  { id: "use", title: "Using 1stSeen fairly" },
  { id: "account", title: "Your account, and ending it" },
  { id: "liability", title: "No guarantee, and limited liability" },
  { id: "changes", title: "Changes to these terms" },
  { id: "contact", title: "Contact" },
] as const;

/** The Terms of Service. A draft for the owner's review, marked as one while LEGAL_PAGES_ARE_DRAFTS is true. */
export default function TermsPage() {
  const email = getContactEmail();
  return (
    <DocumentPage
      eyebrow="Terms of Service"
      title="Terms of Service"
      draft={LEGAL_PAGES_ARE_DRAFTS}
      lede={
        <p>
          These terms apply when you use 1stSeen, with or without an account. They are written to be read: short sentences,
          and what each one means for you.
        </p>
      }
      updated={LEGAL_PAGES_UPDATED}
      contents={CONTENTS}
    >
      <DocumentSection id="service" title="What 1stSeen is">
        <p>
          1stSeen predicts when recurring early-career technical programs, such as internships, co-ops, and new-grad programs,
          are likely to open their next round of applications. It builds each prediction from the public job postings and
          archived career pages it has collected for that program.
        </p>
        <p>
          You can browse forecasts without an account. With an account you can follow roles, get a preparation plan for a
          followed role, and, only if you choose to connect them, add dates to Google Calendar or send yourself a digest
          through Gmail.
        </p>
      </DocumentSection>

      <DocumentSection id="forecasts" title="A forecast is a prediction">
        <ul>
          <li>Every opening date on 1stSeen is a statistical prediction from public evidence. It is not a guarantee.</li>
          <li>
            Nothing on 1stSeen comes from the companies themselves. A company can open early, open late, change a program, or
            not run it at all. The company&apos;s own announcement always wins.
          </li>
          <li>
            How accurate the forecasts are has not yet been measured. The{" "}
            <Link href={sitePage("methodology").href} className="link-accent focus-ring">methodology page</Link> explains how
            they are made and where accuracy stands.
          </li>
          <li>Check the company&apos;s own careers site before you rely on a date.</li>
        </ul>
      </DocumentSection>

      <DocumentSection id="not-advice" title="Not advice">
        <p>
          Nothing on 1stSeen is career, legal, or financial advice. Preparation plans are dates worked back from a forecast by
          fixed rules. They are suggestions, not instructions, and they know nothing about your own circumstances.
        </p>
      </DocumentSection>

      <DocumentSection id="independent" title="Not affiliated with the companies">
        <p>
          1stSeen is independent. It is not affiliated with, endorsed by, or sponsored by any company or program it lists.
          Company and program names are used only to say which company and program a forecast is about, and they remain their
          owners&apos; trademarks.
          {email && (
            <>
              {" "}<Link href={sitePage("data-sources").href} className="link-accent focus-ring">Data sources</Link> says what is
              read, and how a company can ask to be removed.
            </>
          )}
        </p>
      </DocumentSection>

      <DocumentSection id="use" title="Using 1stSeen fairly">
        <p>Use 1stSeen for your own job search, and for research that reads it one page at a time as a person would. Do not:</p>
        <ul>
          <li>scrape, crawl, or bulk-download its pages, forecasts, or evidence, by any means;</li>
          <li>
            send automated requests to extract data, including through the recruiting agent, or run requests in volume to
            get around the limits on questions;
          </li>
          <li>resell, republish, or redistribute forecasts or evidence from 1stSeen, or build a competing dataset from them;</li>
          <li>try to reach another person&apos;s account or data, or probe, overload, or get around the site&apos;s security;</li>
          <li>use 1stSeen to break the law or to harass anyone.</li>
        </ul>
        <p>Questions to the agent without an account are limited, per network address and across the site, to keep it available for everyone.</p>
      </DocumentSection>

      <DocumentSection id="account" title="Your account, and ending it">
        <ul>
          <li>Give an email address you control, and keep your password to yourself. You are responsible for what is done with your account.</li>
          <li>
            You can end your account at any time: in <Link href="/settings" className="link-accent focus-ring">Settings</Link>,
            under Your data, choose Delete account and type the confirmation. It cannot be undone. It deletes everything your
            account owns and your sign-in, and asks Google to revoke any access you gave 1stSeen; only Google can confirm that,
            and if it does not, you are told how to remove the access yourself. Download your data first if you want a copy.
          </li>
          <li>
            1stSeen may suspend or close an account that breaks these terms, for example by scraping or abusing the agent, and
            may refuse access from a network that does. It may also change or stop the service.
          </li>
        </ul>
      </DocumentSection>

      <DocumentSection id="liability" title="No guarantee, and limited liability">
        <p>
          1stSeen is provided as it is, without any promise that it will be accurate, complete, available, or suited to what
          you want it for. As far as the law allows, 1stSeen and the person who runs it are not liable for any loss that comes
          from using it, from not being able to use it, or from relying on a forecast or a plan, including a missed application
          window or opportunity. Some places do not allow some of these limits; where that is so, they apply only as far as the
          law there allows.
        </p>
      </DocumentSection>

      <DocumentSection id="changes" title="Changes to these terms">
        <p>
          When these terms change in substance, the date at the top of this page changes with them. If you keep using 1stSeen
          after a change, the new terms apply. If you do not agree with them, stop using 1stSeen and delete your account.
        </p>
      </DocumentSection>

      <DocumentSection id="contact" title="Contact">
        <p>Questions about these terms go to <ContactAddress email={email} />.</p>
      </DocumentSection>
    </DocumentPage>
  );
}
