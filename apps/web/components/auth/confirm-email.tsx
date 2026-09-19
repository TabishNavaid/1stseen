"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { parseAuthFragment, supabaseHandledLink } from "@/lib/auth/policy";
import { focusRing, textLinkClass } from "@/components/auth/fields";
import { useInitialFragment, useInitialSearch } from "@/components/auth/use-initial-fragment";

type Failure = "link_unusable" | "link_invalid" | "unavailable" | "confirmed_by_supabase";

const failures = {
  confirmed_by_supabase: { title: "Your email address is confirmed", body: "Sign in with your email and password to continue." },
  link_unusable: { title: "This confirmation link has expired or was already used", body: "A link works once, for one hour. If you already confirmed your address, just sign in; if not, sign in with your email and password and we will offer to send a new link." },
  link_invalid: { title: "This confirmation link is incomplete", body: "Part of the link seems to be missing. Open it again from the email, or copy the whole address." },
  unavailable: { title: "Your email couldn't be confirmed right now", body: "Try opening the link again in a moment." },
} as const;

/**
 * Reads the one-time token from the URL fragment, removes it from the address bar and
 * history, and posts it to /api/auth/confirm. The token is never part of a URL that reaches
 * a server.
 */
export function ConfirmEmail() {
  const router = useRouter();
  const fragment = useInitialFragment();
  const search = useInitialSearch();
  const link = fragment === null ? null : parseAuthFragment(fragment, "email");
  // A link Supabase verified itself (its default template) arrives with the result instead of the token.
  const handled = fragment === null || link ? null : supabaseHandledLink(fragment, search ?? "");
  const [failure, setFailure] = useState<Failure | null>(null);
  const started = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A page opened without a usable link fails immediately; that is derived, not stored.
  const shown: Failure | null =
    fragment !== null && !link
      ? handled === "verified" ? "confirmed_by_supabase" : handled === "expired" ? "link_unusable" : "link_invalid"
      : failure;

  useEffect(() => {
    if (fragment === null || started.current) return;
    started.current = true;
    if (fragment || search) window.history.replaceState(null, "", window.location.pathname);
    if (!link) return;
    void fetch("/api/auth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_hash: link.tokenHash, type: link.type }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { error?: string; redirect?: string };
        if (response.ok) {
          router.replace(payload.redirect ?? "/");
          router.refresh();
          return;
        }
        setFailure(payload.error === "link_unusable" ? "link_unusable" : payload.error === "link_invalid" ? "link_invalid" : "unavailable");
      })
      .catch(() => setFailure("unavailable"));
  }, [fragment, search, link, router]);

  useEffect(() => { if (shown) headingRef.current?.focus(); }, [shown]);

  if (!shown) {
    return (
      <section aria-labelledby="confirm-title" className="mt-2">
        <h1 id="confirm-title" className="text-3xl font-semibold tracking-title">Confirming your email</h1>
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-ink"><Icon name="loader-circle" size={16} className="animate-spin" />Checking your link and signing you in…</p>
        <noscript>
          <p className="mt-4 text-sm leading-6 text-warning-ink">Confirming your email needs JavaScript: the link&rsquo;s one-time code stays in your browser and is never sent inside a web address.</p>
        </noscript>
      </section>
    );
  }
  const copy = failures[shown];
  return (
    <section aria-labelledby="confirm-title" className="mt-2">
      <h1 id="confirm-title" ref={headingRef} tabIndex={-1} className={`flex items-start gap-2 rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>
        {shown === "confirmed_by_supabase"
          ? <Icon name="mail-check" size={26} className="mt-1 shrink-0 text-success-ink" />
          : <Icon name="circle-alert" size={26} className="mt-1 shrink-0 text-danger-ink" />}
        {copy.title}
      </h1>
      <div className="mt-6 space-y-4 border border-line bg-surface p-5 text-sm leading-6 text-ink">
        <p>{copy.body}</p>
        <p><Link href="/signin" className={textLinkClass}>Go to sign in</Link></p>
      </div>
    </section>
  );
}
