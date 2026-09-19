"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { PASSWORD_MIN_LENGTH, parseAuthFragment, passwordProblems, supabaseHandledLink } from "@/lib/auth/policy";
import { FormMessage, TextField, focusRing, primaryButtonClass, textLinkClass } from "@/components/auth/fields";
import { useInitialFragment, useInitialSearch } from "@/components/auth/use-initial-fragment";
import { useHydrated } from "@/components/auth/use-hydrated";

type Stage = "verifying" | "choose" | "no_link" | "link_unusable" | "link_invalid" | "link_outdated" | "session_expired";

const stops: Record<Exclude<Stage, "verifying" | "choose">, { title: string; body: string }> = {
  no_link: { title: "Open the link from your reset email", body: "This page needs the link we emailed you. If you don't have one, request a new link." },
  link_unusable: { title: "This reset link has expired or was already used", body: "A reset link works once, for one hour. Request a new one to choose a password." },
  link_invalid: { title: "This reset link is incomplete", body: "Part of the link seems to be missing. Open it again from the email, or request a new link." },
  link_outdated: { title: "Request a new reset link", body: "This link can't be finished on this page. Request a new one and open the newest email." },
  session_expired: { title: "Your reset session has ended", body: "For your security, a reset has to be finished soon after opening the link. Request a new one." },
};

/**
 * Verifies the recovery token from the URL fragment (removed from history immediately), then
 * asks for a new password. `hasSession` lets a reload after verification go straight to the form.
 */
export function ResetPasswordFlow({ hasSession }: { hasSession: boolean }) {
  const router = useRouter();
  const fragment = useInitialFragment();
  const search = useInitialSearch();
  // Until hydration the submit button is disabled, so a native submission can never carry these fields.
  const hydrated = useHydrated();
  const link = fragment ? parseAuthFragment(fragment, "recovery") : null;
  // A link Supabase verified itself (its default template) arrives with a session this page never takes from a URL.
  const handled = fragment === null || link ? null : supabaseHandledLink(fragment, search ?? "");
  // Set only by network outcomes. Before the fragment is read, or without a usable link, the
  // stage is derived: a reload after verification (a live session) goes straight to the form.
  const [outcome, setOutcome] = useState<Stage | null>(null);
  const stage: Stage =
    outcome ??
    (fragment === null
      ? "verifying"
      : link
        ? "verifying"
        : hasSession
          ? "choose"
          : handled === "verified" ? "link_outdated" : handled === "expired" ? "link_unusable" : "no_link");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirmation?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (fragment === null || started.current) return;
    started.current = true;
    if (fragment || search) window.history.replaceState(null, "", window.location.pathname);
    if (!link) return;
    void fetch("/api/auth/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_hash: link.tokenHash, type: link.type }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        setOutcome(response.ok ? "choose" : payload.error === "link_unusable" ? "link_unusable" : "link_invalid");
      })
      .catch(() => setOutcome("link_invalid"));
  }, [fragment, search, link]);

  useEffect(() => { if (stage !== "verifying") headingRef.current?.focus(); }, [stage]);
  useEffect(() => { if (failure) failureRef.current?.focus(); }, [failure]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const next: { password?: string; confirmation?: string } = {};
    const problems = passwordProblems(password);
    if (problems.includes("too_short")) next.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (problems.includes("too_long")) next.password = "Use a shorter password: at most 72 bytes.";
    if (!next.password && confirmation !== password) next.confirmation = "The two passwords don't match.";
    setErrors(next);
    if (next.password) { passwordRef.current?.focus(); return; }
    if (next.confirmation) { confirmationRef.current?.focus(); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/update-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; redirect?: string };
      if (response.ok) {
        router.replace(payload.redirect ?? "/");
        router.refresh();
        return;
      }
      if (payload.error === "reset_session_expired") { setOutcome("session_expired"); return; }
      if (payload.error === "same_password") { setErrors({ password: "Choose a password you haven't used for this account." }); passwordRef.current?.focus(); return; }
      if (payload.error === "weak_password" || payload.error === "invalid_password") { setErrors({ password: "Choose a stronger password." }); passwordRef.current?.focus(); return; }
      setFailure("Your password couldn't be changed right now. Try again in a moment.");
    } catch {
      setFailure("Your password couldn't be changed right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "verifying") {
    return (
      <section aria-labelledby="reset-title" className="mt-2">
        <h1 id="reset-title" className="text-3xl font-semibold tracking-title">Checking your reset link</h1>
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-ink"><Icon name="loader-circle" size={16} className="animate-spin" />One moment…</p>
        <noscript>
          <p className="mt-4 text-sm leading-6 text-warning-ink">Resetting your password needs JavaScript: the link&rsquo;s one-time code stays in your browser and is never sent inside a web address.</p>
        </noscript>
      </section>
    );
  }

  if (stage !== "choose") {
    const copy = stops[stage];
    return (
      <section aria-labelledby="reset-title" className="mt-2">
        <h1 id="reset-title" ref={headingRef} tabIndex={-1} className={`flex items-start gap-2 rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>
          <Icon name="circle-alert" size={26} className="mt-1 shrink-0 text-danger-ink" />{copy.title}
        </h1>
        <div className="mt-6 space-y-4 border border-line bg-surface p-5 text-sm leading-6 text-ink">
          <p>{copy.body}</p>
          <p><Link href="/auth/forgot" className={textLinkClass}>Request a new reset link</Link></p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="reset-title" className="mt-2">
      <h1 id="reset-title" ref={headingRef} tabIndex={-1} className={`rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>Choose a new password</h1>
      <form method="post" noValidate onSubmit={(event) => void submit(event)} className="mt-5 space-y-4 border border-line bg-surface p-5">
        <noscript><p className="text-sm leading-6 text-warning-ink">This form needs JavaScript. Your details are only ever sent in a secure request body, never in a web address.</p></noscript>
        {failure && <FormMessage tone="error" messageRef={failureRef}>{failure}</FormMessage>}
        <TextField
          id="reset-password"
          label="New password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          inputRef={passwordRef}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={errors.password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          id="reset-password-confirmation"
          label="Type it again"
          type="password"
          name="password-confirmation"
          autoComplete="new-password"
          required
          value={confirmation}
          inputRef={confirmationRef}
          error={errors.confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <button type="submit" disabled={busy || !hydrated} className={primaryButtonClass}>
          {busy ? <Icon name="loader-circle" size={16} className="animate-spin" /> : <Icon name="key-round" size={16} />}Save password and sign in
        </button>
      </form>
    </section>
  );
}
