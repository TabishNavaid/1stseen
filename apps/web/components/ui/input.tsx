import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

/** A text input on the control token: 36px high, a 3:1 border, and the focus ring. Label it with `Field`. */
export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={cn("control px-3", className)} {...props} />;
}

/**
 * A native select on the control token. Native keeps the platform's keyboard and screen-reader behavior, and
 * submits with a GET form, so URL-state filters need no script. Label it with `Field`.
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select className={cn("control appearance-none pl-3 pr-8", className)} {...props}>
        {children}
      </select>
      <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
    </span>
  );
}
