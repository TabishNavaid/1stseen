import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type FieldControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

/**
 * A labelled form control with an optional description and error.
 *
 * The label is a real `<label for>`, and the description and error are tied to the control with
 * `aria-describedby`, so a screen reader announces them when the control takes focus. The error also sets
 * `aria-invalid`. Pass the control as a function of those props: `{(control) => <Input {...control} />}`.
 */
export function Field({
  id,
  label,
  description,
  error,
  hideLabel = false,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "label-caps text-ink-subtle"}>
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
      {description && <p id={descriptionId} className="text-caption text-ink-subtle">{description}</p>}
      {error && <p id={errorId} className="text-caption font-semibold text-danger-ink">{error}</p>}
    </div>
  );
}
