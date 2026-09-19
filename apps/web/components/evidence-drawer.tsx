import { Icon, type IconName } from "@/components/ui/icon";
import Link from "next/link";
import type { ForecastRole } from "@firstseen/shared";
import { ConfidenceIndicator } from "@/components/confidence-indicator";
import { ForecastBasisChip } from "@/components/forecast-basis-chip";
import { BASIS, type ForecastBasis } from "@/lib/forecast-basis";
import { ReadinessChecklist } from "@/components/readiness-checklist";
import { SourceBadge } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { useOffCanvas } from "@/components/ui/off-canvas";
import { locationLabel } from "@/lib/presentation";

/**
 * A forecast's evidence, behind a click: the drawer slides over the list at every width, so the list stays clean and
 * the detail (the interval, why this confidence, the signal, the work-back plan, and the evidence) is one tap away.
 */
export function EvidenceDrawer({ role, basis = null, programType, open, onClose }: { role: ForecastRole; basis?: ForecastBasis | null; programType?: string; open: boolean; onClose: () => void }) {
  const panelRef = useOffCanvas<HTMLElement>(open, onClose, "all");
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-scrim" onClick={onClose} aria-hidden="true" />}
      <aside ref={panelRef} className={`${open ? "translate-x-0 transition-transform" : "invisible translate-x-full transition-[transform,visibility]"} fixed inset-y-0 right-0 z-50 w-full max-w-[520px] overflow-y-auto border-l border-line-strong bg-surface shadow-dialog sm:rounded-l-card`} aria-label={`${role.role} forecast detail`}>
        <header className="sticky top-0 z-10 border-b border-line bg-surface/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-line bg-surface-sunken text-sm font-bold text-accent-ink">{role.companyMark}</div><div className="min-w-0 flex-1"><p className="text-caption font-semibold text-ink-subtle">{role.company} · {programType ?? role.track}</p><h2 className="mt-1 text-lg font-semibold tracking-title">{role.role}</h2><p className="mt-1 text-micro text-ink-subtle">{locationLabel(role.location)}</p></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details"><Icon name="x" size={17} /></Button></div>
        </header>

        <div className="space-y-7 p-5">
          <Link href={`/roles/${role.id}`} className="focus-ring flex min-h-touch items-center justify-between rounded-control border border-line bg-surface-selected px-4 py-2.5 text-xs font-semibold text-accent-ink hover:border-accent">Open the full role page <Icon name="arrow-up-right" size={14} /></Link>
          <section className="rounded-card border border-line bg-surface-sunken p-4">
            <div className="flex items-center justify-between gap-4"><div><p className="label-caps text-ink-subtle">Predicted opening interval</p><p className="mt-2 text-xl font-semibold tracking-[-0.035em] tabular">{role.window}</p><p className="mt-1 text-caption text-ink-subtle">Expected opening falls inside this statistical interval.</p></div><ConfidenceIndicator value={role.confidence} /></div>
            {basis && <div className="mt-4 flex flex-wrap items-center gap-2"><ForecastBasisChip basis={basis} /><span className="text-micro text-ink-subtle">{BASIS[basis.kind].meaning}</span></div>}
            <div className="mt-5 grid grid-cols-4 gap-1" aria-label="Historical opening cycles compared with forecast">
              {role.historicalCycles.map((date, index) => <div key={date}><div className="relative h-7 border-t border-line-strong"><span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-accent-ink" style={{ opacity: 0.55 + index * 0.12 }} /></div><p className="text-center text-micro tabular text-ink-subtle">{date}</p></div>)}
            </div>
          </section>

          <section aria-labelledby="confidence-title"><div className="flex items-center justify-between"><h3 id="confidence-title" className="text-sm font-semibold">Why this confidence</h3><span className="text-micro font-medium text-ink-subtle">model evidence</span></div><div className="mt-3 grid grid-cols-2 border-l border-t border-line">{role.confidenceFactors.map((factor) => <div key={factor.label} className="border-b border-r border-line p-3"><p className="text-micro text-ink-subtle">{factor.label}</p><p className={`mt-1 text-xs font-semibold ${factor.tone === "positive" ? "text-accent-ink" : factor.tone === "warning" ? "text-warning-ink" : "text-ink-muted"}`}>{factor.value}</p></div>)}</div></section>

          <section aria-labelledby="signal-title"><div className="flex items-center gap-2"><Icon name="radio" size={14} className="text-warning-ink" /><h3 id="signal-title" className="text-sm font-semibold">Current recruiting signal</h3></div><p className="mt-2 border-l-2 border-warning-line bg-warning-surface px-3 py-2.5 text-caption leading-5 text-ink-muted">{role.signalSummary}</p></section>

          <ReadinessChecklist role={role} />

          <section aria-labelledby="evidence-title"><div className="flex items-center justify-between"><div><p className="label-caps text-ink-subtle">Provenance</p><h3 id="evidence-title" className="mt-1 text-sm font-semibold">Forecast evidence</h3></div><span className="flex items-center gap-1 text-micro text-accent-ink"><Icon name="shield-check" size={12} />traceable</span></div><div className="mt-3 divide-y divide-line border-y border-line">{role.evidence.map((item) => { const iconName: IconName = item.kind === "archive" ? "history" : item.kind === "signal" ? "radio" : "database"; return <article key={`${item.label}-${item.date}`} className="grid grid-cols-[24px_1fr_auto] gap-2 py-3"><Icon name={iconName} size={14} className="mt-0.5 text-ink-subtle" /><div><div className="flex flex-wrap items-center gap-2"><p className="text-caption font-semibold text-ink-muted">{item.label}</p><SourceBadge kind={item.kind === "archive" ? "archive" : item.kind === "signal" ? "signal" : "official"} /></div><p className="mt-1 text-micro text-ink-subtle">{item.detail}</p></div><span className="flex items-start gap-1 whitespace-nowrap text-micro tabular text-ink-subtle">{item.date}<Icon name="arrow-up-right" size={10} /></span></article>; })}</div>{role.evidence.some((item) => item.kind === "archive") && <p className="mt-3 flex gap-2 text-micro leading-4 text-ink-subtle"><Icon name="calendar-range" size={13} className="mt-0.5 shrink-0" />Archive dates show when content existed, not necessarily when it was originally published.</p>}</section>
        </div>
      </aside>
    </>
  );
}
