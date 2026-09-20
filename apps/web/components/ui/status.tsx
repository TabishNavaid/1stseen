import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { Bird } from "@/components/brand/bird";
import { Doodle, type DoodleName } from "@/components/doodle";
import type { BirdPose } from "@/lib/brand/bird-art";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

/**
 * A chip names an applied filter or a chosen value. With `onRemove` it holds a button that removes it;
 * with `removeHref`, a link to the same view without it, for URL-state filters that work without script. The
 * remove control is named "Remove <label>", so it is announced as what it does, and is a 24px target.
 *
 * Removing a chip removes the control that had focus, which would drop a keyboard user back to the start of the
 * page. The button moves focus to the next chip's remove control, or the previous one when it was the last; with
 * no other chip, the caller decides where focus goes.
 */
export function Chip({
  label,
  children,
  onRemove,
  removeHref,
  className,
}: {
  label: string;
  children?: ReactNode;
  onRemove?: () => void;
  removeHref?: string;
  className?: string;
}) {
  const removeClass = "focus-ring grid size-6 shrink-0 place-items-center rounded-chip text-ink-subtle hover:bg-surface-sunken hover:text-ink";
  const removeAndKeepFocus = (event: MouseEvent<HTMLButtonElement>) => {
    const current = event.currentTarget;
    const scope = current.closest("[role=group], [role=list], ul, ol") ?? current.parentElement?.parentElement;
    const controls = scope ? [...scope.querySelectorAll<HTMLElement>("[data-chip-remove]")] : [];
    const index = controls.indexOf(current);
    const next = controls[index + 1] ?? controls[index - 1];
    onRemove?.();
    if (next) requestAnimationFrame(() => next.focus());
  };
  const remove = onRemove ? (
    <button type="button" data-chip-remove onClick={removeAndKeepFocus} aria-label={`Remove ${label}`} className={removeClass}><Icon name="x" size={12} /></button>
  ) : removeHref ? (
    <Link href={removeHref} data-chip-remove aria-label={`Remove ${label}`} className={removeClass}><Icon name="x" size={12} /></Link>
  ) : null;
  return (
    <span className={cn("inline-flex h-7 items-center gap-1 rounded-chip border border-line-strong bg-surface pl-2.5 text-caption font-medium text-ink", remove ? "pr-0.5" : "pr-2.5", className)}>
      {children ?? label}
      {remove}
    </span>
  );
}

/** A decorative loading shape, hidden from assistive technology. Put shapes inside a `LoadingRegion`. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("skeleton block", className)} />;
}

/**
 * A region that is still loading. It is announced once, by its label, as a status; the skeleton shapes
 * inside it are hidden. Motion stops under prefers-reduced-motion.
 */
export function LoadingRegion({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * An empty or insufficient-evidence state. It is a deliberate state, never an error or a blank panel: the
 * title states the fact, the description the reason, and the action the next step. The heading level fits the
 * surrounding outline.
 */
export function EmptyState({
  icon = "search",
  bird,
  doodle,
  title,
  description,
  action,
  headingLevel = 3,
  className,
}: {
  icon?: IconName;
  /** The bird, small, beside whatever else is drawn: a cameo, never the illustration itself. */
  bird?: BirdPose;
  /** A hand-drawn character for the moment, in place of the icon: one mark above the words, never both. */
  doodle?: DoodleName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      <span className="mb-2 flex items-end justify-center gap-2">
        {doodle ? <Doodle name={doodle} size="empty" /> : <Icon name={icon} size={20} className="text-ink-subtle" />}
        {bird && <Bird pose={bird} size="tiny" className="bob-once mb-1" />}
      </span>
      <Heading className="mt-3 text-sm font-semibold text-ink">{title}</Heading>
      {description && <p className="mt-1 max-w-sm text-xs leading-5 text-ink-subtle">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
