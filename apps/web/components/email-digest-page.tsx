"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DigestKind, EmailDigest } from "@/lib/email-digests/digest";
import { cn } from "@/lib/utils";
import { formatDay } from "@/lib/dates";

type GmailStatus = { configured: boolean; connected: boolean; send_enabled: boolean; account_email?: string | null };

const sectionOrder: DigestKind[] = ["role_opened", "opening_soon", "forecast_changed", "networking_deadline", "referral_deadline", "resume_deadline"];
const sectionMeta: Record<DigestKind, { label: string; description: string }> = {
  role_opened: { label: "Programs you watch that opened", description: "Confirmed by the posting itself" },
  opening_soon: { label: "Likely to open soon", description: "From each program's own history" },
  forecast_changed: { label: "Windows that moved", description: "The window before and the window now" },
  networking_deadline: { label: "Time to reach out", description: "From your prep plan" },
  referral_deadline: { label: "Time to ask for a referral", description: "From your prep plan" },
  resume_deadline: { label: "Time to finish your resume", description: "From your prep plan" },
};

export type DigestMode = "real" | "demo" | "signed_out" | "unconfigured";

export function EmailDigestPage({
  mode,
  initialDigest,
  loadError = null,
}: {
  mode: DigestMode;
  initialDigest: EmailDigest | null;
  loadError?: string | null;
}) {
  const [digest, setDigest] = useState<EmailDigest | null>(initialDigest);
  // Only development-fixture content is ever labelled as such; a real preview
  // starts from the signed-in user's own watchlist and never from fixtures.
  const [isFixture, setIsFixture] = useState(mode === "demo");
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"preview" | "status" | "send" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const groups = useMemo(() => digest ? sectionOrder.map((kind) => ({ kind, items: digest.items.filter((item) => item.kind === kind) })).filter((group) => group.items.length) : [], [digest]);

  async function refreshPreview() {
    setBusy("preview"); setMessage(null);
    try {
      const response = await fetch("/api/digests/preview", { cache: "no-store" });
      const body = await response.json() as EmailDigest & { error?: string };
      if (!response.ok) throw new Error(response.status === 401 ? "Create an account or sign in to preview your watched-role digest." : body.error ?? "Preview unavailable.");
      setDigest(body); setIsFixture(false); setMessage("Preview rebuilt from your current structured recruiting data.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preview unavailable."); }
    finally { setBusy(null); }
  }

  async function checkGmail() {
    setBusy("status"); setMessage(null);
    try {
      const response = await fetch("/api/integrations/gmail", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Create an account or sign in to connect Gmail." : "Gmail status unavailable.");
      setGmail(await response.json() as GmailStatus);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Gmail status unavailable."); }
    finally { setBusy(null); }
  }

  async function sendDigest() {
    setBusy("send"); setMessage(null);
    try {
      const response = await fetch("/api/digests/send", { method: "POST" });
      const body = await response.json().catch(() => ({})) as { error?: string; item_count?: number };
      if (!response.ok) throw new Error(body.error === "digest_already_delivered" ? "This exact digest was already delivered." : body.error === "email_delivery_disabled" ? "Email sending is disabled for this environment." : body.error ?? "Digest send failed.");
      setMessage(`Sent ${body.item_count ?? digest?.items.length ?? 0} recruiting updates through your connected Gmail account.`); setConsent(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Digest send failed."); }
    finally { setBusy(null); }
  }

  async function disconnect() {
    setBusy("disconnect"); setMessage(null);
    try {
      const response = await fetch("/api/integrations/gmail", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not disconnect Gmail.");
      setGmail((current) => current ? { ...current, connected: false, account_email: null } : current); setConsent(false); setMessage("Gmail disconnected. Existing delivery history was retained.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not disconnect Gmail."); }
    finally { setBusy(null); }
  }

  return <div className="flex-1 bg-canvas text-ink">
    <main id="digest-content" className="mx-auto max-w-[1480px] px-4 py-7 md:px-6"><section className="grid gap-5 border-b border-line pb-7 lg:grid-cols-[1fr_auto] lg:items-end"><div><h1 className="heading-display mt-3 text-3xl md:text-4xl">Your email digest</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-ink-muted">Exactly what 1stSeen would send you: programs that opened, windows that moved, and the next steps in your prep plan.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void refreshPreview()} disabled={Boolean(busy)} className="gap-2 bg-surface"><Icon name="refresh-cw" size={14} className={busy === "preview" ? "animate-spin" : ""} />Preview my data</Button><Button onClick={() => void checkGmail()} disabled={Boolean(busy)} className="gap-2 bg-accent text-ink-inverse"><Icon name="mail" size={14} />Gmail delivery</Button></div></section>

      <div className="mt-6 grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(330px,.65fr)]"><section className="panel" aria-labelledby="digest-preview-title">{digest === null ? <div className="p-6"><h2 id="digest-preview-title" className="text-lg font-semibold">{mode === "signed_out" ? "Sign in to preview your digest" : mode === "unconfigured" ? "Live data is not configured" : "Preview unavailable"}</h2><p className="mt-2 max-w-xl text-xs leading-6 text-ink-muted">{mode === "signed_out" ? "A digest is built only from your own watchlist, its windows, and your prep steps. There is no sample digest." : mode === "unconfigured" ? "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to build a digest from collected evidence." : loadError ?? "The digest could not be assembled."}</p>{mode === "signed_out" && <div className="mt-4 flex flex-wrap items-center gap-3"><Link href="/signin?mode=sign_up&return_to=%2Fwelcome" className="inline-flex h-9 items-center rounded-md max-sm:h-touch bg-accent px-3 text-xs font-semibold text-ink-inverse">Create an account</Link><Link href="/signin?return_to=%2Fdigests" className="inline-flex h-9 items-center rounded-md max-sm:h-touch border border-line px-3 text-xs font-semibold text-ink-muted">Sign in</Link></div>}</div> : <><div className="border-b border-line p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="digest-preview-title" className="mt-1 text-xl font-semibold tracking-title">{digest.subject}</h2><p className="mt-2 text-xs text-ink-subtle">As of {formatDay(digest.asOf)} · {digest.items.length} update{digest.items.length === 1 ? "" : "s"}</p></div><Badge className={isFixture ? "border-warning-line bg-warning-surface text-warning-ink" : "border-success-line bg-success-surface text-accent-ink"}>{isFixture ? "Fixture preview" : "Your current data"}</Badge></div><div className="mt-4 flex gap-2 border-l-2 border-success-line bg-success-surface px-3 py-2.5 text-micro leading-4 text-ink-muted"><Icon name="shield-check" size={14} className="mt-0.5 shrink-0" />Predicted dates are marked as predictions. A confirmed opening is never written as one.</div></div>
        <div className="divide-y divide-line">{groups.length === 0 && <p className="p-6 text-xs leading-6 text-ink-muted">The programs you watch produced nothing for this period. Nothing is substituted to fill the email.</p>}{groups.map(({ kind, items }) => <section key={kind} className="p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{sectionMeta[kind].label}</h3><p className="mt-1 text-micro text-ink-subtle">{sectionMeta[kind].description}</p></div><span className="grid h-7 w-7 place-items-center rounded-full bg-success-surface text-xs font-semibold text-accent-ink">{items.length}</span></div><div className="mt-3 space-y-2">{items.map((item) => <article key={item.itemKey} className="grid gap-3 border border-line bg-surface-sunken p-3 sm:grid-cols-[94px_1fr]"><div><p className="text-micro font-semibold tabular text-accent-ink">{formatDay(item.eventOn)}</p><p className="mt-1 text-micro text-ink-subtle">{item.company}</p></div><div><p className="text-xs font-semibold">{item.headline}</p><p className="mt-1 text-micro leading-4 text-ink-muted">{item.detail}</p></div></article>)}</div></section>)}</div><div className="border-t border-line bg-surface-sunken px-5 py-3 text-micro leading-4 text-ink-subtle">The same digest is never sent to you twice.</div></>}</section>

        <aside className="space-y-5 xl:sticky xl:top-[78px]"><section className="panel p-5"><h2 className="text-lg font-semibold">Send it to yourself</h2><p className="mt-2 text-xs leading-5 text-ink-muted">Connecting Gmail schedules nothing. A digest is sent only when you press the button and confirm it.</p>{gmail === null ? <Button variant="outline" onClick={() => void checkGmail()} disabled={Boolean(busy)} className="mt-4 w-full gap-2"><Icon name="mail" size={14} />Check connection</Button> : !gmail.configured ? null : !gmail.connected ? <a href="/api/integrations/gmail/connect" className="mt-4 flex h-10 items-center justify-center gap-2 rounded-md bg-accent text-xs font-semibold text-ink-inverse"><Icon name="mail" size={14} />Connect Gmail with consent</a> : <div className="mt-4"><div className="flex items-center gap-2 border border-success-line bg-success-surface p-3"><span className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft text-accent-ink"><Icon name="check" size={13} /></span><div><p className="text-xs font-semibold text-accent-ink">Gmail connected</p><p className="text-micro text-ink-muted">{gmail.account_email}</p></div></div>{!gmail.send_enabled && <p className="mt-3 flex gap-2 text-micro leading-4 text-warning-ink"><Icon name="circle-alert" size={13} className="shrink-0" />Preview-only mode. Actual sends are disabled by server configuration.</p>}<label className="mt-4 flex cursor-pointer gap-2 text-micro leading-4 text-ink-muted"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 accent-accent-ink" />Send this deterministic digest to my connected address. I understand forecast dates are predictions.</label><Button onClick={() => void sendDigest()} disabled={!gmail.send_enabled || !consent || isFixture || Boolean(busy)} className="mt-3 w-full gap-2 bg-accent text-ink-inverse">{busy === "send" ? <Icon name="loader-circle" size={14} className="animate-spin" /> : <Icon name="send" size={14} />}Send this digest</Button><button onClick={() => void disconnect()} disabled={Boolean(busy)} className="mt-3 flex w-full items-center justify-center gap-1.5 text-micro font-semibold text-danger-ink"><Icon name="log-out" size={11} />Disconnect Gmail</button></div>}</section>
          <section className="panel p-5"><p className="flex items-center gap-2 text-xs font-semibold"><Icon name="file-text" size={14} className="text-accent-ink" />What is in it</p><div className="mt-3 space-y-3 text-micro leading-4 text-ink-muted"><p className="flex gap-2"><Icon name="calendar-clock" size={13} className="mt-0.5 shrink-0" />Every date comes from what 1stSeen has on record for the programs you watch.</p><p className="flex gap-2"><Icon name="sparkles" size={13} className="mt-0.5 shrink-0" />Nothing is added that is not already on your watchlist.</p><p className="flex gap-2"><Icon name="bell-ring" size={13} className="mt-0.5 shrink-0" />Nothing is sent unless you send it.</p></div></section>{message && <div className={cn("border p-3 text-micro leading-4", message.includes("Sent") || message.includes("rebuilt") || message.includes("disconnected") ? "border-success-line bg-success-surface text-accent-ink" : "border-warning-line bg-warning-surface text-warning-ink")}>{message}</div>}</aside></div>
      <footer className="mt-7 flex flex-col gap-2 border-t border-line py-4 text-micro leading-4 text-ink-subtle sm:flex-row sm:justify-between"><p>{isFixture ? "Development fixture · reserved .example evidence only" : "Built from your own watchlist"}</p><p>The same digest is never sent to you twice.</p></footer></main></div>;
}
