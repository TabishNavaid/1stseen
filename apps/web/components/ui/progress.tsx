import { cn } from "@/lib/utils";

/** A determinate bar. `label` names it for assistive technology, which WCAG 4.1.2 requires of a progressbar. */
export function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-confidence-track", className)} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="h-full rounded-full bg-success-line transition-[width]" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}
