import type { Metadata } from "next";
import Link from "next/link";
import { DocumentPage, DocumentSection } from "@/components/document-page";
import { PrecisionChip } from "@/components/precision-chip";
import { getContactEmail } from "@/lib/config";
import { BASIS, BASIS_ORDER } from "@/lib/forecast-basis";
import { formatDay } from "@/lib/dates";
import { loadMethodologyData, type MethodologyData } from "@/lib/methodology-data";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Methodology and accuracy",
  description: "How 1stSeen turns public posting history into opening-window forecasts, what the confidence score means, and where accuracy stands.",
};

export const dynamic = "force-dynamic";

const CONTENTS = [
  { id: "accuracy", title: "Where accuracy stands" },
  { id: "evidence", title: "What 1stSeen observes" },
  { id: "forecast", title: "How a forecast is made" },
  { id: "basis", title: "What a window rests on" },
  { id: "confidence", title: "What the confidence score means" },
  { id: "replay", title: "How a backtest keeps hindsight out" },
  { id: "agent", title: "What the agent can and cannot do" },
  { id: "scope", title: "What 1stSeen covers" },
  { id: "limits", title: "What the model does not know" },
] as const;

const count = (value: number, one: string, many = `${one}s`) => `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;

function Accuracy({ data }: { data: MethodologyData | null }) {
  if (!data) {
    return <p>This deployment is not connected to its database, so there is no backtest to report here.</p>;
  }
  const { backtest, depth } = data;
  return (
    <>
      {backtest === null ? (
        <p>
          <strong>Not yet measured.</strong> No backtest has been recorded on this deployment, so there is no measurement of how often
          forecasts are right.
        </p>
      ) : backtest.completedCases === 0 ? (
        <>
          <p>
            <strong>Not yet measured.</strong> The latest backtest, finished {formatDay(backtest.finishedAt.slice(0, 10))}, went back to{" "}
            {count(backtest.targetCount, "past opening")} and tried to forecast each one from only what 1stSeen had recorded{" "}
            {backtest.cutoffDays} days before it opened. It could score none of them.
          </p>
          <p>
            That is the backtest refusing hindsight, not failing. A past opening may be forecast only from facts 1stSeen had recorded
            before it, and 1stSeen has recorded everything it holds since it began collecting, including archive captures from years
            earlier. So no past opening yet has a forecast made in time. The first scorable cases will be programs that open after
            collection began and were forecast before they did, and their number grows with each recruiting season. Until then 1stSeen
            publishes no accuracy figure, because it has none measured without hindsight.
          </p>
        </>
      ) : (
        <>
          <p>
            The latest backtest, finished {formatDay(backtest.finishedAt.slice(0, 10))}, scored {backtest.completedCases.toLocaleString("en-US")} of{" "}
            {count(backtest.targetCount, "past opening")}, each forecast from only what 1stSeen had recorded {backtest.cutoffDays} days
            before it opened.
          </p>
          <dl className="panel grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 px-4 py-3 text-caption">
            {backtest.metrics.intervalCoverage !== null && <><dt>Openings inside the 80% interval</dt><dd className="m-0 text-right font-semibold tabular text-ink">{percent(backtest.metrics.intervalCoverage)}</dd></>}
            {backtest.metrics.medianAbsoluteErrorDays !== null && <><dt>Median distance from the expected date</dt><dd className="m-0 text-right font-semibold tabular text-ink">{count(backtest.metrics.medianAbsoluteErrorDays, "day")}</dd></>}
            {backtest.metrics.meanAbsoluteErrorDays !== null && <><dt>Mean distance from the expected date</dt><dd className="m-0 text-right font-semibold tabular text-ink">{count(backtest.metrics.meanAbsoluteErrorDays, "day")}</dd></>}
            {backtest.metrics.averageIntervalWidthDays !== null && <><dt>Average interval width</dt><dd className="m-0 text-right font-semibold tabular text-ink">{count(backtest.metrics.averageIntervalWidthDays, "day")}</dd></>}
          </dl>
          <p>These describe the scored openings only. Programs without a scorable past opening are not yet measured.</p>
        </>
      )}

      {backtest !== null && backtest.reasons.length > 0 && (
        <table className="w-full border border-line text-caption">
          <caption className="pb-2 text-left text-caption text-ink-subtle">
            Why {backtest.completedCases === 0 ? "each" : "the other"} past opening could not be scored, in the backtest&apos;s own words
          </caption>
          <thead>
            <tr className="bg-surface-sunken text-left">
              <th scope="col" className="label-caps px-3 py-2 font-medium text-ink-subtle">Reason</th>
              <th scope="col" className="label-caps px-3 py-2 text-right font-medium text-ink-subtle">Openings</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {backtest.reasons.map((item) => (
              <tr key={item.reason}>
                <td className="px-3 py-2 text-ink">{item.reason}</td>
                <td className="px-3 py-2 text-right font-semibold tabular text-ink">{item.targets.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        Today {depth.withForecast.toLocaleString("en-US")} of {count(depth.inScopeRoles, "early-career role")} have a forecast.{" "}
        {(depth.byOwnCycles[0] + depth.byOwnCycles[1]).toLocaleString("en-US")} of those rest on one recruiting cycle of the program&apos;s
        own or none, and take the rest of their timing from comparable programs, as described below. Every forecast says how many of
        its own cycles it rests on.
      </p>
      <table className="w-full border border-line text-caption">
        <caption className="pb-2 text-left text-caption text-ink-subtle">Roles by the program&apos;s own recruiting cycles behind today&apos;s forecast</caption>
        <tbody className="divide-y divide-line">
          {([
            ["No cycle of its own, from comparable programs only", depth.byOwnCycles[0]],
            ["One cycle of its own", depth.byOwnCycles[1]],
            ["Two cycles", depth.byOwnCycles[2]],
            ["Three or more cycles", depth.byOwnCycles[3]],
            ["No forecast", depth.withoutForecast],
          ] as const).map(([label, value]) => (
            <tr key={label}>
              <th scope="row" className="px-3 py-2 text-left font-normal text-ink">{label}</th>
              <td className="px-3 py-2 text-right font-semibold tabular text-ink">{value.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Where the footer's disclosure points: the evidence model, the forecast, the confidence score, and the honest backtest position. */
export default async function MethodologyPage() {
  const data = await loadMethodologyData();
  // The data-sources page is published only with a contact address (publishedSitePages in lib/site-links.ts).
  const takedownPublished = getContactEmail() !== null;
  return (
    <DocumentPage
      eyebrow="Methodology and accuracy"
      title="How forecasts are made, and how accurate they are"
      lede={
        <p>
          1stSeen predicts when a recurring internship, co-op, or new-grad program is likely to open its next round of applications,
          from the openings it has observed for that program before. This page explains what it observes, how a forecast is
          computed, what the confidence score means, and where the evidence on accuracy stands today.
        </p>
      }
      updated="2026-09-17"
      contents={CONTENTS}
    >
      <DocumentSection id="accuracy" title="Where accuracy stands">
        <Accuracy data={data} />
      </DocumentSection>

      <DocumentSection id="evidence" title="What 1stSeen observes">
        <p>
          1stSeen reads public job postings from companies&apos; applicant tracking systems (Greenhouse, Lever, Ashby, and
          SmartRecruiters), their public career pages, and archived copies of those pages in the Internet Archive&apos;s Wayback
          Machine. Every observation is stored with the address it came from, when it was observed, and a fingerprint of its content,
          and is never rewritten afterwards.
          {takedownPublished && (
            <>
              {" "}<Link href={sitePage("data-sources").href} className="link-accent focus-ring">Data sources</Link> lists what is
              read and how.
            </>
          )}
        </p>
        <p>From those observations it reconstructs when each program opened in earlier years. Every reconstructed date keeps the precision its source supports:</p>
        <dl className="space-y-2">
          <div className="grid gap-1 sm:grid-cols-[104px_minmax(0,1fr)] sm:gap-3"><dt><PrecisionChip precision="exact" /></dt><dd className="m-0">The job board published the date itself.</dd></div>
          <div className="grid gap-1 sm:grid-cols-[104px_minmax(0,1fr)] sm:gap-3"><dt><PrecisionChip precision="bounded" /></dt><dd className="m-0">A complete archive capture shows the program absent and a later one shows it present, so it opened between the two.</dd></div>
          <div className="grid gap-1 sm:grid-cols-[104px_minmax(0,1fr)] sm:gap-3"><dt><PrecisionChip precision="observed_by" /></dt><dd className="m-0">The program was visible by that date and may have opened earlier. An archive capture timestamp is never treated as an exact opening date.</dd></div>
        </dl>
        <p>The three are stored apart and never promoted into one another, and every date on the site carries its class.</p>
        <p>
          A repost is not a new year. Postings that name the same cohort, such as Summer 2027, count as one recruiting cycle, and
          without a stated cohort, openings less than 300 days apart count as one.
        </p>
      </DocumentSection>

      <DocumentSection id="forecast" title="How a forecast is made">
        <p>A fixed statistical model, <span className="font-mono text-caption">hierarchical-circular-shrinkage-v2</span>, computes every date, interval, and score.</p>
        <ul>
          <li>
            It places each past opening on an annual circle, so late December and early January count as close together, and weighs
            each by its precision, the quality of its source, how surely it belongs to this program, and its age.
          </li>
          <li>
            It produces an expected date and an 80% prediction interval: the range it expects the next opening to fall in. The 80% is
            the interval&apos;s design target. How often real openings land inside it is what the backtest measures.
          </li>
          <li>
            A program with fewer than three recruiting cycles of its own is forecast only when comparable programs (at the same company,
            or in the same field, with the same level and recruiting season) give the model a timing to borrow. Their influence shrinks
            as the program&apos;s own history grows, and such forecasts are wider: roughly 42, 32, or 22 days either side of the expected
            date at the least, for no, one, or two cycles of its own.
          </li>
          <li>
            When there is too little of the program&apos;s own history and nothing comparable to borrow from, the model does not forecast
            it. The role is listed with the evidence that exists, and no date.
          </li>
          <li>
            Recruiting signals, such as a careers page adding an internship section, can raise or lower the confidence score. They
            never move a date or an interval.
          </li>
          <li>
            No language model produces a date, an interval, or a score. A language model may help sort an ambiguous job title or read a
            question to the agent; the numbers come only from the statistical model.
          </li>
          <li>
            Every forecast is stored with the observations it used, the model version, and a fingerprint of its inputs. A forecast is
            never edited: when the evidence changes, a new version is added beside the old one, and the role page lists both.
          </li>
        </ul>
      </DocumentSection>

      <DocumentSection id="basis" title="What a window rests on">
        <p>
          Every forecast says which evidence its window mainly rests on, read from the weights the model recorded for it:
        </p>
        <dl className="space-y-2">
          {BASIS_ORDER.map((kind) => (
            <div key={kind} className="grid gap-1 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
              <dt><span className={`inline-flex items-center rounded-chip border px-2 py-0.5 text-micro font-semibold ${BASIS[kind].className}`}>{BASIS[kind].label}</span></dt>
              <dd className="m-0">{BASIS[kind].meaning}</dd>
            </div>
          ))}
        </dl>
        <p>
          The percentage beside it is that basis&apos;s share of the window&apos;s weight. The number of recruiting cycles does not say
          this on its own: a program with one recorded cycle can take most of its weight from that cycle or almost none, depending
          on how consistent the comparable programs are. Borrowed timing is a real signal, since programs at one company or level
          and season tend to open together, but it describes those programs, not this one.
        </p>
      </DocumentSection>

      <DocumentSection id="confidence" title="What the confidence score means">
        <p>
          Every forecast carries a confidence score from 0 to 100. It scores how much consistent evidence backs the window: how much of
          the program&apos;s own history there is, how consistent its timing has been, the quality and precision of its sources, how
          recent they are, how narrow the interval is, and any current signals. The role page shows each factor.
        </p>
        <p>
          It is not the chance that the window is right, and it has not been calibrated against outcomes, which is why it is written as
          48 / 100 and never as a percentage. A program with little history of its own is capped whatever else supports it: the cap
          rises from 48 through 56, 69, and 82 to 92 as its own weighted history grows.
        </p>
      </DocumentSection>

      <DocumentSection id="replay" title="How a backtest keeps hindsight out">
        <p>
          A backtest goes back to a cutoff before a past opening and forecasts it again from only what 1stSeen knew then.{" "}
          <Link href="/replay" className="link-accent focus-ring">Forecast Replay</Link> runs one such case on request.
        </p>
        <ul>
          <li>Evidence is admitted only when both its date and the moment 1stSeen recorded it fall before the cutoff.</li>
          <li>The opening being predicted is held out by its identity, and comparable programs contribute only evidence that meets the same cutoff.</li>
          <li>An Observed by opening has no defensible actual date, so it is never used to score a forecast; it is skipped, with that reason.</li>
        </ul>
        <p>A single replay is one case. Accuracy is the backtest&apos;s measurement over every scorable case, stated at the top of this page.</p>
      </DocumentSection>

      <DocumentSection id="agent" title="What the agent can and cannot do">
        <p>
          The recruiting agent answers a question by choosing among fixed tools: looking up stored evidence and forecasts, checking
          current postings, and asking the statistical model for a forecast. It cannot write a date or a score itself. While it works it
          shows the tools it ran and what they returned, in counts, and never its prompts or private reasoning.
        </p>
      </DocumentSection>

      <DocumentSection id="scope" title="What 1stSeen covers">
        <p>
          Early-career technical programs: internships, co-ops, new-grad and graduate programs, rotational programs, and technical
          apprenticeships, in software, machine learning, data, quantitative roles, hardware and robotics, every engineering discipline,
          and product and design. Other roles at the same companies are kept as evidence but never listed or forecast.
        </p>
      </DocumentSection>

      <DocumentSection id="limits" title="What the model does not know">
        <ul>
          <li>It assumes a program recurs about once a year. It cannot foresee a program being cancelled, split into several cohorts, or moved.</li>
          <li>
            Public sources are incomplete. A company can open applications somewhere 1stSeen does not read, and archives capture pages
            irregularly, which is why an archived date usually says only that a program was visible by then.
          </li>
          <li>Nothing here comes from the companies themselves. A forecast is a prediction from public evidence, and the company&apos;s own announcement always wins.</li>
        </ul>
      </DocumentSection>
    </DocumentPage>
  );
}
