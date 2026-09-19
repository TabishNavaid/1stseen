"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behavior for a panel that is docked at wide widths and slides over the page below them: the mobile
 * navigation and the forecast detail drawer.
 *
 * While it is open over the page (the media query matches), focus moves to its first control, Tab and Shift+Tab stay
 * inside it, Escape closes it, and closing returns focus to whatever opened it. When closed, the caller hides the panel
 * with `invisible` below the breakpoint, which takes it out of the tab order and the accessibility tree. Transition
 * `visibility` only while closing: a transition into `visible` starts at `hidden`, and focus cannot move into it.
 */
export function useOffCanvas<T extends HTMLElement>(open: boolean, onClose: () => void, overlayQuery: string) {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || !window.matchMedia(overlayQuery).matches) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, overlayQuery]);

  return panelRef;
}
