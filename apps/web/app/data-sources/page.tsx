import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ContactAddress } from "@/components/contact-address";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { collectionHonoursRobotsTxt, getContactEmail } from "@/lib/config";
import { LEGAL_PAGES_ARE_DRAFTS, LEGAL_PAGES_UPDATED } from "@/lib/legal";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Data sources and takedown",
  description: "What 1stSeen reads, how often and how politely, and how a company can ask to be removed.",
};

export const dynamic = "force-dynamic";

const CONTENTS = [
  { id: "sources", title: "What 1stSeen reads" },
  { id: "kept", title: "What it keeps" },
  { id: "pace", title: "How often, and how politely" },
  { id: "robots", title: "robots.txt" },
  { id: "names", title: "Company names and trademarks" },
  { id: "removal", title: "Asking for a company to be removed" },
] as const;

/**
 * Data sources and takedown. Collection bounds are the worker's own (worker/src/firstseen/config.py, the
 * collection workflows' defaults, adapters/feeds.py, discovery.py). The robots.txt section follows ROBOTS_TXT_ENFORCED,
 * the variable the worker reads, so the page never claims more than collection does. docs/takedown.md is the procedure
 * behind the removal section. It is published only when a contact address is configured (publishedSitePages): a takedown
 * procedure nobody can reach is not published.
 */
export default function DataSourcesPage() {
  const email = getContactEmail();
  if (!email) notFound();
  const robots = collectionHonoursRobotsTxt();
  return (
    <DocumentPage
      eyebrow="Data sources"
      title="Data sources and takedown"
      draft={LEGAL_PAGES_ARE_DRAFTS}
      lede={
        <p>
          1stSeen builds its forecasts only from public job postings and public archives of career pages. This page says what
          it reads, how it reads it, and how a company can ask to be left out.
        </p>
      }
      updated={LEGAL_PAGES_UPDATED}
      contents={CONTENTS}
    >
      <DocumentSection id="sources" title="What 1stSeen reads">
        <ul>
          <li>
            <strong>Job-board APIs.</strong> The public endpoints that Greenhouse, Lever, Ashby, and SmartRecruiters publish for
            listing a company&apos;s open jobs.
          </li>
          <li>
            <strong>Company career pages</strong>, and the sitemaps and job feeds those sites publish. Collection reads only
            recruiting pages, such as a careers, jobs, or students page and the job pages a sitemap lists, never a blog,
            news, or product page. When a company is added, its home page, robots.txt, and sitemaps are read to find them.
          </li>
          <li>
            <strong>The Internet Archive&apos;s Wayback Machine.</strong> Its index and its archived copies of a company&apos;s
            careers or campus page, over the last five years, at most 45 copies per page by default. This is how past openings
            are dated.
          </li>
          <li>
            <strong>Reddit</strong> is off by default. It can be turned on only through Reddit&apos;s approved API, for an
            allowlist of communities. No author is recorded, and a post can only support a forecast, never date an opening.
          </li>
        </ul>
        <p>
          Apart from Reddit&apos;s API when it is on, 1stSeen uses no account to read a source, and reads nothing behind a
          sign-in.{" "}
          <Link href={sitePage("methodology").href} className="link-accent focus-ring">Methodology</Link> explains how what it
          reads becomes a forecast.
        </p>
      </DocumentSection>

      <DocumentSection id="kept" title="What it keeps">
        <p>
          For each posting or archived page: its address, when it was seen, its title and location, a publication date if the
          source states one, and at most 64 KB of its text, with a fingerprint of the content. For a career page watched for
          changes, at most 64 KB of its visible text, to tell what was added. Page code is not stored. Every forecast can show
          the evidence it was made from.
        </p>
      </DocumentSection>

      <DocumentSection id="pace" title="How often, and how politely">
        <ul>
          <li>
            On the current schedule, current postings are read twice a day, career pages for changes four times a day,
            and the archive once a week.
          </li>
          <li>
            Requests to any one site are spaced out: by default at least a quarter of a second apart for current postings,
            and a second and a half apart for career pages and the archive.
          </li>
          <li>
            By default each request gives up after 20 seconds and reads at most 10 MB, and a sitemap is followed at most two
            levels deep, five sitemap files and 25 job pages per run.
          </li>
          <li>
            A failed request is not retried until the next scheduled run. When a site answers with an access check or a
            challenge page, collection stops there. It uses no proxies and nothing that gets around a block.
          </li>
          <li>
            Every request identifies itself as <span className="font-mono text-caption">1stSeenEvidenceBot/0.2</span>.
          </li>
        </ul>
      </DocumentSection>

      <DocumentSection id="robots" title="robots.txt">
        {robots ? (
          <>
            <p>
              Before it requests anything from a site, collection reads that site&apos;s robots.txt, once per site per run, and
              skips every address it disallows for <span className="font-mono text-caption">1stSeenEvidenceBot</span> or for all
              crawlers. The job-board APIs and the Wayback Machine are treated the same way.
            </p>
            <ul>
              <li>If a site has no robots.txt, nothing is skipped.</li>
              <li>If its robots.txt cannot be read because the server fails or does not answer, the whole site is skipped for that run.</li>
              <li>Each skip is recorded with the rule that caused it.</li>
            </ul>
          </>
        ) : (
          <p>
            Collection does not yet check robots.txt before each request. It reads a site&apos;s robots.txt only to find the
            sitemaps listed there. The limits above apply to every site, and a site that does not want to be read can ask, as
            described below, and collection from it stops.
          </p>
        )}
      </DocumentSection>

      <DocumentSection id="names" title="Company names and trademarks">
        <p>
          Company and program names are used only to say which company and which program a forecast is about. They remain
          their owners&apos; trademarks. 1stSeen shows no company logos. It is independent: no company it lists is affiliated
          with it or has endorsed it.
        </p>
      </DocumentSection>

      <DocumentSection id="removal" title="Asking for a company to be removed">
        <p>
          If you speak for a company and want 1stSeen to stop reading its sites, or to take the company off 1stSeen, write to{" "}
          <ContactAddress email={email} /> and name the company and its website.
        </p>
        <ol>
          <li>You get a reply within two business days. It may ask you to confirm the request from an address at the company&apos;s own domain.</li>
          <li>
            Once the request is confirmed, and within five business days, collection from the sites you name stops, before the
            next scheduled run. If you asked for the company to be removed, its programs also leave every page, the watchlists
            that followed them, and the agent&apos;s answers, and every other program&apos;s forecast that used its postings is
            recomputed without them.
          </li>
          <li>You get a reply saying what was done, and when.</li>
        </ol>
        <p>
          What was already collected is kept, out of sight of every page, unless you also ask for it to be erased. Then it is
          erased within 30 days, and 1stSeen keeps only the company&apos;s name, its web addresses, and the record of your
          request, so that it is never collected again.
        </p>
      </DocumentSection>
    </DocumentPage>
  );
}
