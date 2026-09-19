import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-white hover:bg-accent-hover",
        outline: "border border-line-strong bg-surface text-ink hover:bg-surface-hover",
        ghost: "text-ink-muted hover:bg-surface-hover hover:text-ink",
      },
      // Below sm every size meets the 44px touch target.
      size: { default: "h-10 px-4 max-sm:h-touch", sm: "h-8 px-3 text-xs max-sm:h-touch", icon: "h-9 w-9 max-sm:size-touch" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
