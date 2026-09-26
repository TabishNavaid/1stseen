"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/ui/icon";
import { navItems, type NavKey } from "@/lib/site-nav";
import { cn } from "@/lib/utils";

const itemClass = (active: boolean) =>
  cn(
    "focus-ring inline-flex h-9 items-center gap-1.5 rounded-chip px-3 text-sm font-medium transition-colors",
    active ? "bg-accent-soft text-accent-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
  );

/**
 * The header bar every page but the first run shares: the wordmark, the navigation (lib/site-nav.ts), the page's own
 * action, and the account. Below the `lg` breakpoint the navigation folds into a menu that opens under the bar.
 */
export function SiteHeaderBar({
  active,
  signedIn,
  email,
  status,
  actions,
  contentId,
}: {
  active: NavKey | null;
  signedIn: boolean;
  email: string | null;
  status?: ReactNode;
  actions?: ReactNode;
  contentId: string;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const items = navItems(signedIn);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      {/* The whole hidden-until-focused behaviour is one utility (globals.css); composing it out of sr-only and padding put a painted box over the wordmark. */}
      <a href={`#${contentId}`} className="skip-link">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 md:px-6">
          <BrandMark />
          <nav aria-label="Primary" className="hidden lg:block">
            <ul className="flex items-center gap-1">
              {items.map((item) => (
                <li key={item.key}>
                  <Link href={item.href} aria-current={active === item.key ? "page" : undefined} className={itemClass(active === item.key)}>
                    <Icon name={item.icon} size={14} />{item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {status && <span className="hidden sm:inline-flex">{status}</span>}
            {actions}
            {signedIn ? (
              <Link href="/settings" className="focus-ring hidden h-9 items-center gap-2 rounded-chip px-2 text-sm font-medium text-ink-muted hover:bg-surface-hover hover:text-ink lg:inline-flex" title={email ? `Signed in as ${email}` : undefined}>
                <span className="grid size-7 place-items-center rounded-full bg-warm-soft text-xs font-bold uppercase text-warm-ink" aria-hidden="true">{(email ?? "?").slice(0, 1)}</span>
                Settings
              </Link>
            ) : (
              <span className="hidden items-center gap-2 lg:flex">
                <Link href="/signin" className="focus-ring inline-flex h-9 items-center rounded-chip px-3 text-sm font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink">Sign in</Link>
                <Link href="/welcome" className="focus-ring inline-flex h-9 items-center rounded-chip bg-accent px-4 text-sm font-semibold text-ink-inverse hover:bg-accent-hover">Get started</Link>
              </span>
            )}
            <button
              type="button"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
              aria-controls={menuId}
              className="focus-ring -mr-2 grid size-touch place-items-center rounded-control text-ink-muted hover:bg-surface-hover hover:text-ink lg:hidden"
            >
              <Icon name={open ? "x" : "menu"} size={20} />
              <span className="sr-only">Menu</span>
            </button>
          </div>
        </div>
        <div id={menuId} hidden={!open} className="border-t border-line bg-surface lg:hidden">
          <nav aria-label="Primary" className="mx-auto max-w-[1440px] px-4 py-3">
            <ul className="grid gap-1">
              {items.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={active === item.key ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "focus-ring flex min-h-touch items-center gap-3 rounded-control px-3 py-2 text-sm font-semibold",
                      active === item.key ? "bg-accent-soft text-accent-ink" : "text-ink hover:bg-surface-hover",
                    )}
                  >
                    <Icon name={item.icon} size={16} />{item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
              {signedIn ? (
                <Link href="/settings" onClick={() => setOpen(false)} className="focus-ring inline-flex min-h-touch items-center rounded-chip border border-line-strong px-4 text-sm font-semibold text-ink">Settings</Link>
              ) : (
                <>
                  <Link href="/welcome" onClick={() => setOpen(false)} className="focus-ring inline-flex min-h-touch items-center rounded-chip bg-accent px-4 text-sm font-semibold text-ink-inverse">Get started</Link>
                  <Link href="/signin" onClick={() => setOpen(false)} className="focus-ring inline-flex min-h-touch items-center rounded-chip border border-line-strong px-4 text-sm font-semibold text-ink">Sign in</Link>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>
    </>
  );
}
