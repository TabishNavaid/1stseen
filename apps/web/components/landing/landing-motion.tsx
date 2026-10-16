"use client";

import { useEffect } from "react";

/**
 * The landing page's motion, and the only place in the product that loads an animation library.
 *
 * Three rules hold it in:
 *
 *  - **Nothing is imported under `prefers-reduced-motion`.** The check happens before the dynamic imports, so a
 *    reader who asked for less motion does not download a scroll library to not use it. The page is complete
 *    without any of this: every beat below animates *from* a start state with `gsap.from`, so the finished state is
 *    what the server rendered and what a browser with no script, a failed chunk or a blocked request shows.
 *  - **Landing route only.** This component is mounted by the landing page and nothing else, and the libraries are
 *    behind `import()`, so they are their own chunks and no other route's bundle names them.
 *  - **Self-hosted.** Both are ordinary dependencies, bundled by the build, so `script-src 'self'` is satisfied and
 *    there is no CDN in the path.
 *
 * What it animates is the hero's argument, in the order the card makes it: the record of past openings, the window
 * drawn under them, and then the date, which arrives last because it is what the record is for. Below the fold each
 * section rises as it is reached, which is the one thing a scroll library is actually for.
 */
export function LandingMotion() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const [{ gsap }, { ScrollTrigger }, { default: Lenis }] = await Promise.all([
        import("gsap"),
        import("gsap/ScrollTrigger"),
        import("lenis"),
      ]);
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);

      // Smooth scrolling, on this route only: it is mounted here and destroyed when the reader leaves.
      const lenis = new Lenis({ duration: 0.9, smoothWheel: true });
      let frame = 0;
      const raf = (time: number) => {
        lenis.raf(time);
        frame = requestAnimationFrame(raf);
      };
      frame = requestAnimationFrame(raf);
      // ScrollTrigger reads scroll position, and Lenis is the one moving it, so it has to hear about every tick.
      lenis.on("scroll", ScrollTrigger.update);

      const context = gsap.context(() => {
        // The hero, once, on arrival. `from` means the end state is the rendered one.
        const record = document.querySelector('[data-beat="record"]');
        const date = document.querySelector('[data-beat="date"]');
        if (record || date) {
          const hero = gsap.timeline({ defaults: { ease: "power2.out" } });
          if (record) hero.from(record, { opacity: 0, y: 14, duration: 0.5 }, 0);
          // The date resolves after the record has been read, not alongside it.
          if (date) hero.from(date, { opacity: 0, y: 18, duration: 0.6 }, 0.45);
        }

        // Everything below the fold arrives as it is reached.
        for (const section of document.querySelectorAll("[data-reveal]")) {
          const children = section.querySelectorAll("[data-reveal-item]");
          const targets = children.length > 0 ? children : [section];
          gsap.from(targets, {
            opacity: 0,
            y: 20,
            duration: 0.55,
            ease: "power2.out",
            stagger: children.length > 0 ? 0.08 : 0,
            scrollTrigger: { trigger: section, start: "top 85%", once: true },
          });
        }
      });

      cleanup = () => {
        context.revert();
        cancelAnimationFrame(frame);
        lenis.destroy();
        for (const trigger of ScrollTrigger.getAll()) trigger.kill();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return null;
}
