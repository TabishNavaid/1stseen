import type { Metadata } from "next";
import Link from "next/link";
import { ContactAddress } from "@/components/contact-address";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { getContactEmail } from "@/lib/config";
import { LEGAL_PAGES_ARE_DRAFTS, LEGAL_PAGES_UPDATED } from "@/lib/legal";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What 1stSeen keeps about you, why, where it is stored, who hosts it, and how to get a copy or delete it.",
};

export const dynamic = "force-dynamic";

const CONTENTS = [
  { id: "summary", title: "The short version" },
  { id: "account", title: "Your account" },
  { id: "choices", title: "What you tell 1stSeen" },
  { id: "agent", title: "Questions you ask the agent" },
  { id: "google", title: "Google Calendar and Gmail" },
  { id: "cookies", title: "Cookies and browser storage" },
  { id: "hosts", title: "Where it is stored, and who hosts it" },
  { id: "retention", title: "How long it is kept, and what is logged" },
  { id: "rights", title: "Getting a copy, and deleting it" },
  { id: "changes", title: "Changes to this policy" },
] as const;

/**
 * The Privacy Policy. Every statement is checked against the code and schema: the tables a user owns
 * (supabase/migrations), the cookies set (lib/supabase/server.ts, the two OAuth connect routes), what an agent run
 * persists (worker/src/firstseen/agent.py, repository.py), and the deletion and export contract in Settings.
 */
export default function PrivacyPage() {
  const email = getContactEmail();
  return (
    <DocumentPage
      eyebrow="Privacy Policy"
      title="Privacy Policy"
      draft={LEGAL_PAGES_ARE_DRAFTS}
      lede={
        <p>
          This page says what 1stSeen keeps about you, why, where it is stored, and how to get a copy or delete it. If
          something here is unclear, write to <ContactAddress email={email} />.
        </p>
      }
      updated={LEGAL_PAGES_UPDATED}
      contents={CONTENTS}
    >
      <DocumentSection id="summary" title="The short version">
        <ul>
          <li>You can read 1stSeen without an account. Then it keeps nothing about you beyond the questions you ask its agent.</li>
          <li>
            An account keeps your email address, a hash of your password, the roles you follow, your first-run answers, and
            your preparation plans.
          </li>
          <li>Google Calendar and Gmail are used only if you connect them, and their access tokens are stored encrypted.</li>
          <li>1stSeen does not sell your data, shows no advertising, and runs no analytics or advertising trackers.</li>
          <li>You can download everything your account holds, and delete the account, from Settings.</li>
        </ul>
      </DocumentSection>

      <DocumentSection id="account" title="Your account">
        <p>
          Sign-in is run by Supabase Auth. It stores your email address and a one-way hash of your password, never the password
          itself. It also records when you signed up and last signed in, and keeps a record of each signed-in session and of
          sign-in events, with the network address and software that made each request. Supabase sends the email that confirms
          your address and the one that resets your password.
        </p>
        <p>
          1stSeen keeps a profile for the account: a display name, taken from the part of your email address before the @, and
          a time zone, which is UTC unless changed.
        </p>
        <p>These exist so that you can sign in and your follows and plans stay yours. They are used for nothing else.</p>
      </DocumentSection>

      <DocumentSection id="choices" title="What you tell 1stSeen">
        <ul>
          <li>
            <strong>Follows.</strong> Each company, role, field, or program type you follow, and whether alerts are on for it.
            Your watchlist, dashboard, calendar, and digest are built from these.
          </li>
          <li>
            <strong>First-run answers.</strong> The kinds of role you chose, your graduation year, the season, and the places
            you gave, and when you finished or skipped the questions. They choose which roles to suggest, and you can change
            them in Settings. The same record can hold company-size preferences and priority companies, which no page asks
            for today.
          </li>
          <li>
            <strong>Preparation plans.</strong> For a followed role with a forecast, the milestones worked back from it, such as
            when to have a résumé ready, with their due dates, and when you mark one done.
          </li>
        </ul>
      </DocumentSection>

      <DocumentSection id="agent" title="Questions you ask the agent">
        <p>When you ask the recruiting agent a question, 1stSeen stores a record of the run:</p>
        <ul>
          <li>the question, with any email address or phone number in it replaced, cut to its first 1,000 characters;</li>
          <li>the role you asked from, if you asked on a role&apos;s page;</li>
          <li>which tools the agent ran, when, whether each worked, and a short summary with counts of what it found;</li>
          <li>the answer it gave, with the evidence and forecast it cited.</li>
        </ul>
        <p>
          If you are signed in, the record is linked to your account. If you are not, it is stored with no account and no
          network address. The site&apos;s public activity panel can show the tools the latest question without an account
          ran, and their summaries, but never a question&apos;s text, and never a run started by a signed-in person.
        </p>
        <p>
          Questions without an account are counted per network address for one minute, to limit them. The address is used as
          that count&apos;s key by Cloudflare and is not stored by 1stSeen.
        </p>
        <p>
          By default the agent uses no language model: fixed rules read your question. The operator can turn on
          model-assisted reading. Then a question the rules cannot place, up to its first 2,000 characters, is sent to the
          configured model provider only to choose which of the agent&apos;s tools to run, and 1stSeen records which provider
          and model answered and how many tokens it used, not the question again.
        </p>
      </DocumentSection>

      <DocumentSection id="google" title="Google Calendar and Gmail">
        <p>
          These are optional, and each is connected separately. Nothing about them is stored unless you connect one. Access
          tokens are encrypted with AES-256-GCM before they are stored, and each is bound to your account and to the service it
          belongs to, so it cannot be used for anyone else.
        </p>
        <ul>
          <li>
            <strong>Google Calendar</strong> keeps the encrypted tokens, the permission Google granted, when you connected,
            and, for each date you added, the Google event&apos;s ID and a fingerprint of what was written, so adding it again
            updates the event instead of copying it.
          </li>
          <li>
            <strong>Gmail</strong> keeps the encrypted tokens, the permissions granted, and your Google account&apos;s email
            address, which is where a digest is sent. For each digest you send, it keeps the recipient, subject, contents,
            whether it was sent, and Gmail&apos;s ID for the message.
          </li>
        </ul>
        <p>
          <Link href={sitePage("google-data").href} className="link-accent focus-ring">Google data use</Link> lists the exact
          permissions each one asks for and everything done with them.
        </p>
      </DocumentSection>

      <DocumentSection id="cookies" title="Cookies and browser storage">
        <p>1stSeen sets these cookies, and no others:</p>
        <ul>
          <li>
            <strong>The sign-in cookie</strong>, named <span className="font-mono text-caption">sb-…-auth-token</span> and split
            into numbered parts when it is long. It keeps you signed in. It is set when you sign in, removed when you sign out,
            and otherwise kept for up to 400 days.
          </li>
          <li>
            <strong>Six connection cookies</strong>, <span className="font-mono text-caption">firstseen_google_oauth_state</span>,{" "}
            <span className="font-mono text-caption">_verifier</span>, and <span className="font-mono text-caption">_user</span>,
            and the same three for <span className="font-mono text-caption">firstseen_gmail_oauth</span>. They are set only when
            you start connecting Google Calendar or Gmail, prove that the reply from Google belongs to the request you started,
            and are deleted when Google sends you back, or after ten minutes.
          </li>
        </ul>
        <p>
          Every one of them is readable only by the server (HttpOnly), is not sent with requests from other sites (SameSite=Lax),
          and is sent only over HTTPS on the live site. 1stSeen stores nothing in your browser&apos;s local storage, session
          storage, or IndexedDB. Its pages load no third-party scripts, fonts, or trackers.
        </p>
      </DocumentSection>

      <DocumentSection id="hosts" title="Where it is stored, and who hosts it">
        <p>1stSeen shares your data with no one. These services host it or run the code that handles it:</p>
        <ul>
          <li><strong>Supabase</strong> runs the Postgres database where everything above is stored, and sign-in.</li>
          <li><strong>Cloudflare</strong> runs the website on Cloudflare Workers. Every page request passes through it.</li>
          <li>
            <strong>Google Cloud Run</strong> runs the agent service. It receives your question and, if you are signed in, your
            account ID, from the website, not from your browser.
          </li>
          <li>
            <strong>GitHub Actions</strong> runs the scheduled jobs that refresh forecasts, and writes preparation plans for the
            accounts that follow a role, by account ID.
          </li>
          <li><strong>Google</strong>, only if you connect Google Calendar or Gmail.</li>
          <li><strong>A language model provider</strong>, only if the operator turns on model-assisted question reading, as above.</li>
        </ul>
        <p>1stSeen would disclose data to anyone else only where the law requires it.</p>
      </DocumentSection>

      <DocumentSection id="retention" title="How long it is kept, and what is logged">
        <ul>
          <li>Your account and everything it owns are kept until you delete the account.</li>
          <li>Disconnecting Google Calendar or Gmail asks Google to revoke 1stSeen&apos;s access and deletes the stored tokens straight away.</li>
          <li>Questions asked without an account are kept, with no link to a person. There is no automatic expiry yet.</li>
          <li>
            1stSeen&apos;s own logs record a failed background sign-in step by its error code and status only, never an email
            address. Supabase, Cloudflare, and Google Cloud keep their own operational logs of the requests they handle.
          </li>
        </ul>
      </DocumentSection>

      <DocumentSection id="rights" title="Getting a copy, and deleting it">
        <p>
          In <Link href="/settings" className="link-accent focus-ring">Settings</Link>, under Your data:
        </p>
        <ul>
          <li>
            <strong>Download your data</strong> gives you a JSON file of everything your account owns.
          </li>
          <li>
            <strong>Delete account</strong> asks you to type a confirmation, and cannot be undone. It deletes every record your
            account owns and deletes your sign-in. That is 1stSeen&apos;s to guarantee, and nothing another service does can
            stop it.
          </li>
        </ul>
        <p>
          Deleting your account also asks Google to revoke any access you gave 1stSeen to your Google Calendar or Gmail. Only
          Google can revoke that access, so 1stSeen cannot guarantee it. If Google does not confirm, your account is deleted
          all the same, 1stSeen asks Google again for a short while without keeping the token anywhere, and the page you land on
          tells you to remove the access yourself at{" "}
          <a href="https://myaccount.google.com/connections" className="link-accent focus-ring">myaccount.google.com/connections</a>.
        </p>
        <p>
          Dates you already added to Google Calendar are in your calendar, not in 1stSeen, and a digest you sent is in your
          mailbox. When you delete your account you can choose to have 1stSeen remove the calendar dates it added. If Google
          Calendar does not let it, the account is deleted anyway and you are told some dates may remain.
        </p>
        <p>
          You can change your first-run answers and follows at any time. If you cannot sign in, or want something the Settings
          page does not offer, write to <ContactAddress email={email} />.
        </p>
      </DocumentSection>

      <DocumentSection id="changes" title="Changes to this policy">
        <p>When this policy changes in substance, the date at the top of the page changes with it.</p>
      </DocumentSection>
    </DocumentPage>
  );
}
