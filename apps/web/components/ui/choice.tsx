import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A native checkbox with its label and optional description. The row is at least 44px high and the label
 * is part of the hit area, so the control is easy to reach without making the box itself large.
 */
export function Checkbox({
  id,
  label,
  description,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & { id: string; label: ReactNode; description?: ReactNode }) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn("flex min-h-touch items-start gap-2.5", className)}>
      <input type="checkbox" id={id} aria-describedby={descriptionId} className="focus-ring mt-3 size-4 shrink-0 accent-accent" {...props} />
      <div className="flex-1 py-2.5">
        <label htmlFor={id} className="block cursor-pointer text-xs font-medium text-ink">{label}</label>
        {description && <p id={descriptionId} className="mt-0.5 text-caption text-ink-subtle">{description}</p>}
      </div>
    </div>
  );
}

export type RadioOption = { value: string; label: ReactNode; description?: ReactNode };

/**
 * Native radios in a fieldset whose legend names the group. Arrow keys move and select within the group
 * and Tab leaves it, as the platform does, so no script is needed and a GET form submits the choice.
 */
export function RadioGroup({
  name,
  legend,
  options,
  value,
  defaultValue,
  onValueChange,
  description,
  hideLegend = false,
  className,
}: {
  name: string;
  legend: ReactNode;
  options: readonly RadioOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  description?: ReactNode;
  hideLegend?: boolean;
  className?: string;
}) {
  const base = name.replace(/[^A-Za-z0-9_-]/g, "-");
  const descriptionId = description ? `${base}-description` : undefined;
  return (
    <fieldset className={cn("m-0 grid border-0 p-0", className)} aria-describedby={descriptionId}>
      <legend className={hideLegend ? "sr-only" : "label-caps mb-1 p-0 text-ink-subtle"}>{legend}</legend>
      {description && <p id={descriptionId} className="mb-1 text-caption text-ink-subtle">{description}</p>}
      {options.map((option, index) => {
        const id = `${base}-${index}`;
        const optionDescriptionId = option.description ? `${id}-description` : undefined;
        return (
          <div key={option.value} className="flex min-h-touch items-start gap-2.5">
            <input
              type="radio"
              id={id}
              name={name}
              value={option.value}
              aria-describedby={optionDescriptionId}
              {...(value !== undefined ? { checked: value === option.value, onChange: () => onValueChange?.(option.value) } : { defaultChecked: defaultValue === option.value })}
              className="focus-ring mt-3 size-4 shrink-0 accent-accent"
            />
            <div className="flex-1 py-2.5">
              <label htmlFor={id} className="block cursor-pointer text-xs font-medium text-ink">{option.label}</label>
              {option.description && <p id={optionDescriptionId} className="mt-0.5 text-caption text-ink-subtle">{option.description}</p>}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
