import Link from "next/link";
import type { ProfileActivity } from "@/lib/profile-data";
import { formatDateWith, formatShortDay } from "@/lib/dates";

/**
 * What this person has here, in four short lines and one sentence.
 *
 * Every number is a count of records this account actually holds, and each one is a link to where those records are
 * shown — the same rule the roles view follows. A watched program the model has refused a window is counted as
 * watched and nothing more; it is never given a date to make the summary read better.
 */
export function ProfileActivitySummary({ activity, memberSince }: { activity: ProfileActivity; memberSince: string }) {
  const { watchedRoles, withWindow, next, prepSteps } = activity;
  const figures = [
    { key: "watched", value: watchedRoles, label: watchedRoles === 1 ? "program watched" : "programs watched", href: watchedRoles ? "/roles?watched=1" : "/roles" },
    { key: "window", value: withWindow, label: withWindow === 1 ? "has a likely date" : "have a likely date", href: watchedRoles ? "/calendar" : "/roles" },
    { key: "prep", value: prepSteps.total - prepSteps.done, label: prepSteps.total - prepSteps.done === 1 ? "prep step to do" : "prep steps to do", href: "/calendar" },
  ].filter((figure) => figure.value > 0);

  return (
    <section aria-labelledby="activity-title" className="mt-8">
      <h2 id="activity-title" className="text-base font-semibold">Where you are</h2>
      {watchedRoles === 0 ? (
        <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">
          You are not watching anything yet.{" "}
          <Link href="/roles" className="link-accent focus-ring">Browse the programs</Link> and save the ones you want the dates for.
        </p>
      ) : (
        <>
          <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4 border-t border-line pt-4">
            {figures.map((figure) => (
              <div key={figure.key} className="grid gap-0.5">
                <dt className="order-2 text-caption text-ink-subtle">{figure.label}</dt>
                <dd className="order-1 m-0">
                  <Link href={figure.href} className="focus-ring heading-display text-3xl tabular text-ink hover:text-accent-ink">{figure.value}</Link>
                </dd>
              </div>
            ))}
          </dl>
          {next && (
            <p className="mt-4 text-sm leading-6 text-ink">
              Next up, {next.label.toLowerCase()} for the{" "}
              <Link href={next.href} className="link-accent focus-ring">{next.role} at {next.company}</Link>,{" "}
              {next.semantics === "predicted" ? "around" : "on"} {formatShortDay(next.date)}.
            </p>
          )}
          {prepSteps.overdue > 0 && (
            <p className="mt-1 text-sm leading-6 text-warm-ink">
              {prepSteps.overdue === 1 ? "One prep step is past its date." : `${prepSteps.overdue} prep steps are past their dates.`}{" "}
              <Link href="/calendar" className="link-accent focus-ring">Open the calendar</Link>
            </p>
          )}
        </>
      )}
      <p className="mt-4 text-caption text-ink-subtle">
        With 1stSeen since {formatDateWith(memberSince.slice(0, 10), { month: "long", year: "numeric" })}.
      </p>
    </section>
  );
}
