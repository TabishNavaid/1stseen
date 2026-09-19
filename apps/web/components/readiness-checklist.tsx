import { Icon } from "@/components/ui/icon";
import type { ForecastRole } from "@firstseen/shared";
import { Progress } from "@/components/ui/progress";

export function ReadinessChecklist({ role }: { role: ForecastRole }) {
  return (
    <section aria-labelledby="readiness-title">
      <div className="flex items-end justify-between">
        <div><p className="label-caps text-ink-subtle">Work-back plan</p><h3 id="readiness-title" className="mt-1 text-sm font-semibold">Application readiness</h3></div>
        {role.deadlines.length > 0 && <span className="text-sm font-semibold tabular text-accent-ink">{role.readiness}%</span>}
      </div>
      {role.deadlines.length > 0
        ? <Progress value={role.readiness} label="Application readiness" className="mt-3" />
        : <p className="mt-2 text-caption text-ink-muted">{role.nextDeadline}</p>}
      <div className="mt-4 divide-y divide-line border-y border-line">
        {role.deadlines.map((deadline) => (
          <div key={deadline.label} className="grid grid-cols-[24px_1fr_auto] items-center gap-2 py-3">
            <span className={deadline.done ? "grid h-5 w-5 place-items-center rounded-full bg-success-line text-white" : "grid h-5 w-5 place-items-center rounded-full border border-line-strong text-ink-subtle"}>{deadline.done ? <Icon name="check" size={12} /> : <Icon name="clock-3" size={11} />}</span>
            <div><p className={deadline.done ? "text-xs text-ink-subtle line-through" : "text-xs font-semibold text-ink-muted"}>{deadline.label}</p>{!deadline.done && <p className="mt-0.5 text-micro text-ink-subtle">Calculated from the opening interval</p>}</div>
            <time className="text-caption font-medium tabular text-ink-subtle">{deadline.date}</time>
          </div>
        ))}
      </div>
    </section>
  );
}
