import type { InputHTMLAttributes, ReactNode, Ref } from "react";

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
export const primaryButtonClass = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-ink-inverse hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
export const secondaryButtonClass = `inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
export const textLinkClass = `rounded-sm font-semibold text-accent-ink underline underline-offset-2 hover:text-accent ${focusRing}`;

/**
 * A labelled input whose hint and error are programmatically associated with it
 * (aria-describedby), with aria-invalid set while an error is shown.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  inputRef,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">{label}</label>
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs leading-5 text-ink-muted">{hint}</p>}
      <input
        id={id}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`mt-1.5 h-11 w-full rounded-md border bg-surface px-3 text-sm text-ink ${error ? "border-danger-line" : "border-line-strong"} ${focusRing}`}
        {...input}
      />
      {error && <p id={`${id}-error`} className="mt-1.5 text-xs font-medium leading-5 text-danger-ink">{error}</p>}
    </div>
  );
}

/**
 * Form-level message. Errors use role="alert" so they are announced as they appear; the
 * container takes focus so keyboard and screen-reader users land on it.
 */
export function FormMessage({
  tone,
  messageRef,
  children,
}: {
  tone: "error" | "info";
  messageRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={messageRef}
      tabIndex={-1}
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border p-3 text-sm leading-6 ${tone === "error" ? "border-danger-line bg-danger-surface text-danger-ink" : "border-success-line bg-success-surface text-success-ink"} ${focusRing}`}
    >
      {children}
    </div>
  );
}
