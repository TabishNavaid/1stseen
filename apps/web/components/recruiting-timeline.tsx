import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/** One program that opened: the date its posting went up, who, what, and where to apply. */
export type OpenedProgram = {
  id: string;
  roleId: string | null;
  company: string;
  role: string;
  details: string;
  /** The ISO date, when known; a development fixture has only its label. */
  openedOn: string | null;
  openedLabel: string;
  applyUrl: string | null;
};

/**
 * Programs that just opened, newest first. Each date is the job board's own publication date, so "opened" is a fact,
 * never an estimate; each row links to the program and, when the posting is known, to the posting itself.
 */
export function RecruitingTimeline({ programs }: { programs: OpenedProgram[] }) {
  return (
    <ol className="grid gap-3">
      {programs.map((program) => (
        <li key={program.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-5 sm:p-5">
          <p className="flex shrink-0 items-center gap-3 sm:w-28 sm:flex-col sm:items-start sm:gap-0.5">
            <span className="text-micro font-semibold uppercase tracking-label text-ink-subtle">Opened</span>
            {program.openedOn
              ? <time dateTime={program.openedOn} className="heading-display text-xl tabular text-ink">{program.openedLabel}</time>
              : <span className="heading-display text-xl tabular text-ink">{program.openedLabel}</span>}
          </p>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-ink-muted">{program.company}</p>
            <h2 className="mt-0.5 text-base font-semibold leading-snug text-ink">
              {program.roleId
                ? <Link href={`/roles/${program.roleId}`} className="focus-ring rounded-sm hover:underline max-sm:inline-flex max-sm:min-h-touch max-sm:items-center">{program.role}</Link>
                : program.role}
            </h2>
            <p className="mt-1 text-caption text-ink-subtle">{program.details}</p>
          </div>
          {program.applyUrl && (
            <a href={program.applyUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-touch shrink-0 items-center justify-center gap-1.5 self-start rounded-chip bg-accent px-4 text-sm font-semibold text-ink-inverse hover:bg-accent-hover sm:self-center">
              See the posting<Icon name="arrow-up-right" size={14} />
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}
