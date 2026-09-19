"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that counts up once, the first time it is scrolled into view.
 *
 * It is rendered at its final value on the server, so the number is right before any script runs and right for anyone
 * whose motion is reduced or whose JavaScript never arrives. The count only replaces a number that is already correct.
 */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const started = performance.now();
      const step = (now: number) => {
        const part = Math.min(1, (now - started) / 900);
        setShown(Math.round(value * (1 - (1 - part) ** 3)));
        if (part < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }, { threshold: 0.4 });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value]);

  return <span ref={ref} className={className}>{shown.toLocaleString("en-US")}</span>;
}
