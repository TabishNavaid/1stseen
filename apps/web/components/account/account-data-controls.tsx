"use client";

import { useId, useState, type FormEvent, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/choice";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/overlay";
import { DELETE_CONFIRMATION_PHRASE, confirmationMatches, deletionFailureMessage } from "@/lib/account/policy";

const EXPORT_PATH = "/api/account/export";

type Props = { calendarConnected: boolean; gmailConnected: boolean; activeSyncedEvents: number };

/**
 * Settings' "Your data": download everything the account holds, or delete the account.
 *
 * The download is a plain link, so it works before hydration; once hydrated it is fetched instead, so a failure is said
 * on the page rather than saved as a file. Deleting asks for the typed phrase, which the route checks again, and offers
 * the same choice about synced Google Calendar events that disconnecting does.
 */
export function AccountDataControls({ calendarConnected, gmailConnected, activeSyncedEvents }: Props) {
  const formId = useId();
  const [downloading, setDownloading] = useState(false);
  const [downloadProblem, setDownloadProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [events, setEvents] = useState<"keep" | "remove">("keep");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const offerEventsChoice = calendarConnected && activeSyncedEvents > 0;
  const googleConnected = calendarConnected || gmailConnected;
  const matches = confirmationMatches(phrase);
  const eventsNoun = activeSyncedEvents === 1 ? "event" : `${activeSyncedEvents} events`;

  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (downloading) return;
    setDownloading(true);
    setDownloadProblem(null);
    try {
      const response = await fetch(EXPORT_PATH, { cache: "no-store" });
      if (!response.ok) {
        setDownloadProblem(response.status === 401 ? "Your session has ended. Sign in again to download your data." : "Your data could not be exported just now. Try again.");
        return;
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "1stseen-account.json";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setDownloadProblem("Your data could not be exported just now. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setPhrase("");
    setProblem(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/auth/delete-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: phrase, remove_synced_events: offerEventsChoice && events === "remove" }),
      });
      const body = (await response.json().catch(() => null)) as { status?: string; redirect?: string; error?: string } | null;
      if (response.ok && body?.status === "deleted" && typeof body.redirect === "string" && /^\/(?![/\\])/.test(body.redirect)) {
        // A full navigation, so nothing rendered for the deleted account stays in the client router's cache.
        window.location.assign(body.redirect);
        return;
      }
      setProblem(deletionFailureMessage(body as Parameters<typeof deletionFailureMessage>[0], response.status));
    } catch {
      setProblem("The request did not finish, so 1stSeen cannot say whether your account was deleted. Reload this page: if you are still signed in, your account exists and you can try again.");
    }
    setBusy(false);
  }

  return (
    <>
      <div className="panel mt-4 divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 max-w-lg">
            <h3 className="text-sm font-semibold">Download your data</h3>
            <p className="mt-0.5 text-caption text-ink-subtle">
              One JSON file with your answers, watchlist, readiness plans, calendar and digest records, Google connection
              status, and the questions you asked the agent. It never contains a Google token.
            </p>
            {downloadProblem && <p role="alert" className="mt-1 text-caption font-semibold text-danger-ink">{downloadProblem}</p>}
          </div>
          <a href={EXPORT_PATH} download onClick={download} aria-busy={downloading || undefined} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1.5 text-sm">
            <Icon name={downloading ? "loader-circle" : "file-text"} size={14} className={downloading ? "animate-spin" : undefined} />
            {downloading ? "Preparing your file…" : "Download your data"}
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 max-w-lg">
            <h3 className="text-sm font-semibold">Delete account</h3>
            <p className="mt-0.5 text-caption text-ink-subtle">
              Deletes your account and everything it holds{googleConnected ? ", and revokes 1stSeen's access to your Google account" : ""}. This cannot be undone.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setOpen(true)} className="border-danger-line text-danger-ink hover:bg-danger-surface">
            <Icon name="triangle-alert" size={14} />Delete account
          </Button>
        </div>
      </div>

      <Dialog
        open={open}
        onClose={close}
        title="Delete your account?"
        description="This permanently deletes your 1stSeen account. It cannot be undone, and 1stSeen cannot restore it."
        footer={
          <>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel</Button>
            <Button type="submit" form={formId} disabled={!matches || busy} className="bg-danger-ink text-ink-inverse hover:bg-danger-ink hover:opacity-90">
              {busy ? <><Icon name="loader-circle" size={14} className="animate-spin" />Deleting…</> : "Delete account"}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} method="post" className="grid gap-4 text-xs leading-5 text-ink-muted">
          <div>
            <p className="font-semibold text-ink">Deleting your account:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {googleConnected && (
                <li>asks Google to revoke 1stSeen&apos;s access to your Google account. Your data is deleted whatever Google answers; if Google does not confirm, you will be shown where to remove the access yourself;</li>
              )}
              <li>deletes your answers, watchlist, readiness plans, calendar and digest records, Google connections, and the questions you asked the agent;</li>
              <li>deletes your sign-in and signs you out.</li>
            </ul>
            <p className="mt-2">
              Want a copy first? <a href={EXPORT_PATH} download onClick={download} className="link-accent focus-ring">{downloading ? "Preparing your file…" : "Download your data"}</a>.
            </p>
            {downloadProblem && <p className="mt-1 font-semibold text-danger-ink">{downloadProblem}</p>}
          </div>
          {offerEventsChoice && (
            <RadioGroup
              name="synced-events"
              legend={`The ${eventsNoun} 1stSeen added to your Google Calendar`}
              value={events}
              onValueChange={(value) => setEvents(value === "remove" ? "remove" : "keep")}
              options={[
                { value: "keep", label: "Keep them in my calendar", description: "They stay as ordinary events, and 1stSeen can no longer change them." },
                { value: "remove", label: "Remove them", description: "1stSeen deletes them from your calendar before it revokes its access." },
              ]}
            />
          )}
          <Field id={`${formId}-phrase`} label={<>Type <span className="font-mono normal-case tracking-normal text-ink">{DELETE_CONFIRMATION_PHRASE}</span> to confirm</>}>
            {(control) => (
              <Input
                {...control}
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy}
              />
            )}
          </Field>
          {problem && <p role="alert" className="border border-danger-line bg-danger-surface p-3 font-semibold text-danger-ink">{problem}</p>}
        </form>
      </Dialog>
    </>
  );
}
