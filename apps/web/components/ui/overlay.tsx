"use client";

import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A button that opens a non-modal panel, for filter menus and details.
 *
 * The button reports aria-expanded and controls the panel, which is a dialog labelled by the button. Opening
 * moves focus to the panel's first focusable element, or to the panel. While it is open, Escape closes it and
 * returns focus to the button, a pointer press outside closes it, and moving focus out of it closes it.
 */
export function Popover({
  label,
  summary,
  children,
  align = "start",
  className,
  leading,
  chevron = true,
  buttonClassName,
  panelClassName,
}: {
  label: string;
  summary?: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Drawn before the label, such as a lock on a navigation item a guest cannot use yet. */
  leading?: ReactNode;
  chevron?: boolean;
  /** Replaces the filter-button look, for a popover opened from navigation. */
  buttonClassName?: string;
  panelClassName?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonId = `${id}-button`;
  const panelId = `${id}-panel`;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const button = buttonRef.current;
    if (!panel || !button) return;
    (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.contains(target) && !button.contains(target)) setOpen(false);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && !panel.contains(next) && next !== button) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    panel.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      panel.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className={buttonClassName ?? "focus-ring inline-flex h-control items-center gap-1.5 rounded-control border border-line-strong bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-hover max-sm:h-touch"}
      >
        {leading}
        {label}
        {summary && <span className="font-normal text-ink-subtle">{summary}</span>}
        {chevron && <Icon name="chevron-down" size={12} />}
      </button>
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-labelledby={buttonId}
        tabIndex={-1}
        hidden={!open}
        className={cn(
          "absolute top-full z-40 mt-1 min-w-56 rounded-overlay border border-line-strong bg-surface p-3 text-ink shadow-popover focus:outline-none",
          align === "end" ? "right-0" : "left-0",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A modal dialog on the native `<dialog>` element.
 *
 * `showModal()` puts it in the top layer and makes the rest of the page inert, so focus stays inside. Escape and
 * a press on the backdrop ask the parent to close it; closing returns focus to the element that had it. Escape is
 * handled on keydown as well as through the native `cancel` event, which some browsers and input paths do not fire.
 * The dialog is labelled by its title and described by its description. The parent owns `open`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const requestClose = () => onCloseRef.current();
    // A press on the backdrop lands on the <dialog> itself; the content fills its box.
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) requestClose();
    };
    const onCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose();
    };
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open || dialog.open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      returnFocus?.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      className={cn("m-auto w-[min(32rem,calc(100vw-2rem))] rounded-overlay border border-line-strong bg-surface p-0 text-ink shadow-dialog backdrop:bg-scrim", className)}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id={`${id}-title`} className="pt-2 text-base font-semibold tracking-title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-2 grid size-touch shrink-0 place-items-center rounded-control text-ink-subtle hover:bg-surface-hover hover:text-ink">
            <Icon name="x" size={16} />
          </button>
        </div>
        {description && <p id={`${id}-description`} className="mt-1 text-xs leading-5 text-ink-subtle">{description}</p>}
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * A tooltip that describes its trigger: role="tooltip", tied to the trigger with aria-describedby.
 *
 * It shows on hover and on keyboard focus, stays while the pointer moves onto the tooltip itself (WCAG 1.4.13
 * hoverable), and Escape dismisses it without moving focus (dismissible). It carries a description only: never
 * the trigger's accessible name and never anything interactive. The trigger must be a single focusable element.
 */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" }) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [pointerOver, setPointerOver] = useState(false);
  const [lingering, setLingering] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (focused || pointerOver || lingering);

  // Leaving the trigger keeps the tooltip up briefly, so the pointer can move onto it.
  useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), 150);
    return () => window.clearTimeout(timer);
  }, [lingering]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const enter = () => {
    setPointerOver(true);
    setLingering(false);
    setDismissed(false);
  };
  const leave = () => {
    setPointerOver(false);
    setLingering(true);
  };

  if (!isValidElement<Record<string, unknown>>(children)) return <>{children}</>;
  const existing = typeof children.props["aria-describedby"] === "string" ? `${children.props["aria-describedby"]} ` : "";
  const trigger = cloneElement(children, {
    "aria-describedby": `${existing}${id}`,
    onFocus: () => {
      setFocused(true);
      setDismissed(false);
    },
    onBlur: () => setFocused(false),
    onPointerEnter: enter,
    onPointerLeave: leave,
  });

  return (
    <span className="relative inline-flex" onPointerLeave={leave}>
      {trigger}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        onPointerEnter={enter}
        className={cn(
          "absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-control bg-ink px-2.5 py-1.5 text-caption text-ink-inverse shadow-popover",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}
