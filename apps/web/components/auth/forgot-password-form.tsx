"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Doodle } from "@/components/doodle";
import { Icon } from "@/components/ui/icon";
import { normalizeEmail } from "@/lib/auth/policy";
import { FormMessage, TextField, focusRing, primaryButtonClass, textLinkClass } from "@/components/auth/fields";
import { ResendButton } from "@/components/auth/resend-button";
import { useHydrated } from "@/components/auth/use-hydrated";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  // Until hydration the submit button is disabled, so a native submission can never carry these fields.
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (sentTo) sentRef.current?.focus(); }, [sentTo]);
  useEffect(() => { if (failure) failureRef.current?.focus(); }, [failure]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const address = normalizeEmail(email);
    if (!address) {
      setError("Enter a full email address, including the @ and the domain.");
      emailRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address }) });
      if (response.status === 202) setSentTo(address);
      else setFailure(response.status === 503 ? "Password reset is not configured here." : "The reset email could not be requested. Try again in a moment.");
    } catch {
      setFailure("The reset email could not be requested. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <section aria-labelledby="reset-sent-title" className="mt-2">
        {/* The link is on its way: a moment of waiting, not of doing. */}
        <Doodle name="float" size="small" className="mb-4" />
        <h1 id="reset-sent-title" ref={sentRef} tabIndex={-1} className={`flex items-center gap-2 rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>
          <Icon name="mail-check" size={26} />Check your email
        </h1>
        <div className="mt-6 space-y-4 border border-line bg-surface p-5 text-sm leading-6 text-ink">
          <p>
            If an account uses <strong className="break-all font-semibold">{sentTo}</strong>, a link to choose a new password is on its
            way. Open it in this browser. The link works once and expires in one hour.
          </p>
          <ResendButton endpoint="/api/auth/forgot" email={sentTo} />
          <p><Link href="/signin" className={textLinkClass}>Back to sign in</Link></p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="forgot-title" className="mt-2">
      <h1 id="forgot-title" className="text-3xl font-semibold tracking-title">Reset your password</h1>
      <p className="mt-3 text-sm leading-6 text-ink-muted">Enter the email address for your account and we will send a link to choose a new password.</p>
      <form method="post" noValidate onSubmit={(event) => void submit(event)} className="mt-5 space-y-4 border border-line bg-surface p-5">
        <noscript><p className="text-sm leading-6 text-warning-ink">This form needs JavaScript. Your details are only ever sent in a secure request body, never in a web address.</p></noscript>
        {failure && <FormMessage tone="error" messageRef={failureRef}>{failure}</FormMessage>}
        <TextField
          id="forgot-email"
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          inputRef={emailRef}
          error={error}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={busy || !hydrated} className={primaryButtonClass}>
          {busy ? <Icon name="loader-circle" size={16} className="animate-spin" /> : <Icon name="key-round" size={16} />}Send reset link
        </button>
        <p className="text-sm"><Link href="/signin" className={textLinkClass}>Back to sign in</Link></p>
      </form>
    </section>
  );
}
