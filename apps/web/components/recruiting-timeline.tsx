import { Icon } from "@/components/ui/icon";
import type { OpenedRole } from "@/lib/demo-data";
import { SourceBadge } from "@/components/source-badge";

/** `total` counts every opening the list is drawn from; when the list is shorter, it says it is the newest of them. */
export function RecruitingTimeline({ roles, total = roles.length }: { roles: OpenedRole[]; total?: number }) {
  return (
    <section className="border border-line bg-surface" aria-labelledby="opened-title">
      <div className="flex items-end justify-between border-b border-line px-4 py-3"><div><p className="label-caps text-accent-ink">Observed now</p><h2 id="opened-title" className="mt-1 text-sm font-semibold">Roles that opened</h2></div><span className="text-micro text-ink-subtle">{total > roles.length ? `The ${roles.length} most recent of ${total}` : "verified sources"}</span></div>
      {roles.length === 0 ? <div className="p-8 text-center"><Icon name="clock-3" size={24} className="mx-auto text-ink-subtle" /><p className="mt-3 text-sm font-semibold">No openings observed</p><p className="mt-1 text-xs text-ink-subtle">Watched sources will appear here when a role is first seen.</p></div> : (
        <div>{roles.map((role) => <article key={role.id} className="grid gap-3 border-b border-line px-4 py-4 last:border-0 sm:grid-cols-[24px_1fr_auto] sm:items-center"><Icon name="circle-check" size={17} className="text-accent-ink" /><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-xs font-semibold text-ink">{role.company} · {role.role}</h3><SourceBadge kind="official" label={role.source} /></div><p className="mt-1 text-micro text-ink-subtle">{role.location} · {role.observedAt}</p></div><a href={role.applyUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-touch items-center gap-1 text-caption font-semibold text-accent-ink hover:underline sm:min-h-0">Opened {role.openedAt}<Icon name="arrow-up-right" size={12} /></a></article>)}</div>
      )}
    </section>
  );
}
