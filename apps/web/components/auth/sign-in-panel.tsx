"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { PASSWORD_MIN_LENGTH, normalizeEmail, passwordProblems } from "@/lib/auth/policy";
import { FormMessage, TextField, focusRing, primaryButtonClass, textLinkClass } from "@/components/auth/fields";
import { ResendButton } from "@/components/auth/resend-button";
import { useHydrated } from "@/components/auth/use-hydrated";

type Mode = "sign_in" | "sign_up";
type FieldErrors = { email?: string; password?: string };
type Message = { tone: "error" | "info"; text: string; offerResend?: boolean };

const serverMessages: Record<string, Message> = {
  invalid_credentials: { tone: "error", text: "The email or password is incorrect. Check both and try again, or reset your password." },
  email_not_confirmed: { tone: "error", text: "Confirm your email address before signing in. Open the link we sent, or send a new one.", offerResend: true },
  rate_limited: { tone: "error", text: "Too many attempts from this network. Wait a minute, then try again." },
  supabase_unavailable: { tone: "error", text: "Sign-in is not configured for this deployment." },
};
const unavailable: Message = { tone: "error", text: "Sign-in isn't available right now. Try again in a moment." };

export function SignInPanel({ returnTo, initialMode = "sign_in" }: { returnTo: string; initialMode?: Mode }) {
  const router = useRouter();
  // Until hydration the submit button is disabled, so a native submission can never carry these fields.
  const hydrated = useHydrated();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const checkEmailRef = useRef<HTMLHeadingElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Focus follows every state change: the form message, the check-email panel, or the new form heading.
  useEffect(() => { if (message) messageRef.current?.focus(); }, [message]);
  useEffect(() => { if (sentTo) checkEmailRef.current?.focus(); }, [sentTo]);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (!sentTo) headingRef.current?.focus();
  }, [mode, sentTo]);

  function switchMode(next: Mode) {
    setMode(next);
    setErrors({});
    setMessage(null);
  }

  function validate(): boolean {
    const next: FieldErrors = {};
    if (!normalizeEmail(email)) next.email = "Enter a full email address, including the @ and the domain.";
    const problems = passwordProblems(password);
    if (mode === "sign_up" && problems.includes("too_short")) next.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (mode === "sign_up" && problems.includes("too_long")) next.password = "Use a shorter password: at most 72 bytes.";
    else if (mode === "sign_in" && !password) next.password = "Enter your password.";
    setErrors(next);
    if (next.email) emailRef.current?.focus();
    else if (next.password) passwordRef.current?.focus();
    return !next.email && !next.password;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const response = await fetch(mode === "sign_in" ? "/api/auth/sign-in" : "/api/auth/sign-up", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, return_to: returnTo }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; redirect?: string };
      if (mode === "sign_up" && response.status === 202) {
        setPassword("");
        setSentTo(normalizeEmail(email));
        return;
      }
      if (mode === "sign_in" && response.ok) {
        router.replace(payload.redirect ?? returnTo);
        router.refresh();
        return;
      }
      if (payload.error === "invalid_email") { setErrors({ email: "Enter a full email address, including the @ and the domain." }); emailRef.current?.focus(); return; }
      if (payload.error === "invalid_password") { setErrors({ password: `Use between ${PASSWORD_MIN_LENGTH} characters and 72 bytes.` }); passwordRef.current?.focus(); return; }
      setMessage(serverMessages[payload.error ?? ""] ?? unavailable);
    } catch {
      setMessage(unavailable);
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    const address = normalizeEmail(email);
    if (!address) return;
    await fetch("/api/auth/resend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: address }) }).catch(() => null);
    setMessage(null);
    setSentTo(address);
  }

  if (sentTo) {
    return (
      <section aria-labelledby="check-email-title" className="mt-2">
        <h1 id="check-email-title" ref={checkEmailRef} tabIndex={-1} className={`flex items-center gap-2 rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>
          <Icon name="mail-check" size={26} />Check your email
        </h1>
        <div className="mt-6 space-y-4 border border-line bg-surface p-5 text-sm leading-6 text-ink">
          <p>
            If <strong className="break-all font-semibold">{sentTo}</strong> can be used for a new 1stSeen account, a confirmation
            link is on its way. Open it in this browser to finish signing in. The link works once and expires in one hour.
          </p>
          <p>
            Already have an account with this address?{" "}
            <button type="button" onClick={() => { setSentTo(null); switchMode("sign_in"); }} className={textLinkClass}>Sign in</button>
            {" "}or <Link href="/auth/forgot" className={textLinkClass}>reset your password</Link>.
          </p>
          <ResendButton endpoint="/api/auth/resend" email={sentTo} />
          <button type="button" onClick={() => { setSentTo(null); setEmail(""); switchMode("sign_up"); }} className={textLinkClass}>
            Use a different email address
          </button>
        </div>
      </section>
    );
  }

  const signingUp = mode === "sign_up";
  return (
    <section aria-labelledby="auth-title" className="mt-2">
      <h1 id="auth-title" ref={headingRef} tabIndex={-1} className={`rounded-sm text-3xl font-semibold tracking-title ${focusRing}`}>
        {signingUp ? "Create an account" : "Sign in"}
      </h1>
      <p className="mt-3 text-sm leading-6 text-ink-muted">
        Browsing is open to everyone. An account keeps your watchlist, calendar, and prep plans.
      </p>
      <div role="group" aria-label="Account" className="mt-5 grid grid-cols-2 gap-1 rounded-md border border-line bg-surface-sunken p-1">
        {(["sign_in", "sign_up"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            onClick={() => switchMode(option)}
            className={`h-9 rounded text-sm font-semibold max-sm:h-touch ${mode === option ? "bg-surface text-ink shadow-sm" : "text-ink-muted hover:text-ink"} ${focusRing}`}
          >
            {option === "sign_in" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>
      <form method="post" noValidate onSubmit={(event) => void submit(event)} className="mt-4 space-y-4 border border-line bg-surface p-5">
        <noscript><p className="text-sm leading-6 text-warning-ink">This form needs JavaScript. Your details are only ever sent in a secure request body, never in a web address.</p></noscript>
        {message && (
          <FormMessage tone={message.tone} messageRef={messageRef}>
            {message.text}
            {message.offerResend && (
              <> <button type="button" onClick={() => void resendConfirmation()} className={textLinkClass}>Send the confirmation email again</button></>
            )}
          </FormMessage>
        )}
        <TextField
          id="auth-email"
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          inputRef={emailRef}
          error={errors.email}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={() => { if (email && !normalizeEmail(email)) setErrors((current) => ({ ...current, email: "Enter a full email address, including the @ and the domain." })); }}
        />
        <TextField
          id="auth-password"
          label="Password"
          type="password"
          name="password"
          autoComplete={signingUp ? "new-password" : "current-password"}
          required
          value={password}
          inputRef={passwordRef}
          hint={signingUp ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
          error={errors.password}
          onChange={(event) => { setPassword(event.target.value); if (errors.password) setErrors((current) => ({ ...current, password: undefined })); }}
        />
        <button type="submit" disabled={busy || !hydrated} className={primaryButtonClass}>
          {busy ? <Icon name="loader-circle" size={16} className="animate-spin" /> : signingUp ? <Icon name="user-plus" size={16} /> : <Icon name="log-in" size={16} />}
          {signingUp ? "Create account" : "Sign in"}
        </button>
        {!signingUp && (
          <p className="text-sm"><Link href="/auth/forgot" className={textLinkClass}>Forgot your password?</Link></p>
        )}
      </form>
    </section>
  );
}
