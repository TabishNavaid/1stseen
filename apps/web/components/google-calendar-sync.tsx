"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useOffCanvas } from "@/components/ui/off-canvas";
import type { CalendarEvent } from "@/lib/calendar-data";
import { cn } from "@/lib/utils";

type Status = {
  configured: boolean;
  connected: boolean;
  account_label?: string | null;
  synced_source_keys: string[];
};

const syncable = (event: CalendarEvent) => event.semantics === "readiness" || event.semantics === "predicted";

export function GoogleCalendarSync({ events }: { events: CalendarEvent[] }) {
  const [open, setOpen] = useState(false);
  const panelRef = useOffCanvas<HTMLElement>(open, () => setOpen(false), "all");
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const options = useMemo(() => events.filter(syncable).sort((a, b) => a.date.localeCompare(b.date)), [events]);

  async function loadStatus() {
    try {
      const response = await fetch("/api/integrations/google-calendar", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Create an account or sign in to connect a calendar." : "Calendar status is unavailable.");
      setStatus(await response.json() as Status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Calendar status is unavailable.");
    }
  }

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function sync() {
    setBusy(true);
    setMessage(null);
    try {
      const chosen = options.filter((event) => selected.includes(event.id));
      const response = await fetch("/api/integrations/google-calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: chosen.map((event) => ({
          sourceKey: event.id,
          eventType: event.type,
          date: event.date,
          company: event.company,
          role: event.role,
          label: event.label,
          detail: event.detail,
          confidence: event.confidence,
          roleUrl: new URL(event.href, window.location.origin).toString(),
        })) }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; results?: Array<{ action: string }> };
      if (!response.ok) throw new Error(body.error ?? "Calendar sync failed.");
      const changed = body.results?.filter((item) => item.action !== "unchanged").length ?? 0;
      setMessage(changed ? `${changed} selected calendar event${changed === 1 ? "" : "s"} synced.` : "Selected events are already up to date.");
      setSelected([]);
      await loadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Calendar sync failed.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(removeSyncedEvents: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/google-calendar", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_synced_events: removeSyncedEvents }),
      });
      if (!response.ok) throw new Error("Could not disconnect Google Calendar.");
      setStatus((current) => current ? { ...current, connected: false, synced_source_keys: [] } : current);
      setMessage(removeSyncedEvents ? "Disconnected and removed synced events." : "Disconnected. Existing Google events were kept.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not disconnect Google Calendar.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Button onClick={() => { setOpen(true); if (!status) void loadStatus(); }} className="gap-2 bg-accent text-ink-inverse hover:bg-accent-hover"><Icon name="calendar-plus" size={14} />Google Calendar</Button>
    {open && <><div className="fixed inset-0 z-40 bg-scrim" onClick={() => setOpen(false)} aria-hidden="true" /><aside ref={panelRef} role="dialog" aria-modal="true" className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col border-l border-line-strong bg-surface shadow-dialog" aria-label="Google Calendar sync"><div className="flex items-start justify-between border-b border-line p-5"><div><p className="label-caps text-accent-ink">Explicit opt-in</p><h2 className="mt-1 text-xl font-semibold tracking-title">Sync to Google Calendar</h2><p className="mt-2 max-w-sm text-xs leading-5 text-ink-muted">Nothing syncs automatically. Choose each readiness milestone or forecast boundary you want.</p></div><Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" size={17} /></Button></div>
      <div className="border-b border-line p-4">{!status ? <div className="flex items-center gap-2 text-xs text-ink-muted"><Icon name="loader-circle" size={14} className="animate-spin" />Checking connection…</div> : !status.configured ? <div className="flex gap-2 border border-warning-line bg-warning-surface p-3 text-xs leading-5 text-warning-ink"><Icon name="circle-alert" size={15} className="mt-0.5 shrink-0" /><span>Google Calendar sync is not set up on this deployment, so dates stay in 1stSeen. Everything on this page still works; sync needs Google OAuth credentials added by whoever runs this deployment.</span></div> : !status.connected ? <div><p className="text-xs leading-5 text-ink-muted">Connect your Google account before choosing events. Google will ask to let 1stSeen view and edit events on all your calendars; 1stSeen only adds, updates, and removes the events you choose here. <a href="/privacy/google#calendar" className="link-accent focus-ring">How Google data is used</a></p><a href="/api/integrations/google-calendar/connect" className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-xs font-semibold text-ink-inverse"><Icon name="calendar-plus" size={14} />Connect Google Calendar</a></div> : <div className="flex items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-xs font-semibold text-accent-ink"><span className="grid h-5 w-5 place-items-center rounded-full bg-accent-soft"><Icon name="check" size={11} /></span>Google Calendar connected</p>{status.account_label && <p className="ml-7 mt-1 text-micro text-ink-subtle">{status.account_label}</p>}</div><Badge className="border-success-line bg-success-surface text-accent-ink">{status.synced_source_keys.length} synced</Badge></div>}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4"><div className="space-y-2">{options.map((event) => { const checked = selected.includes(event.id); const synced = status?.synced_source_keys.includes(event.id); return <label key={event.id} className={cn("flex cursor-pointer gap-3 border p-3", checked ? "border-success-line bg-success-surface" : "border-line bg-surface")}><input type="checkbox" className="mt-1 accent-accent-ink" checked={checked} disabled={!status?.connected || busy} onChange={() => toggle(event.id)} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-semibold">{event.company} · {event.label}</p>{synced && <span className="shrink-0 text-micro font-semibold text-accent-ink">Synced</span>}</div><p className="mt-1 text-micro text-ink-subtle">{event.date} · {event.role}</p>{event.semantics === "predicted" && <p className="mt-2 border-l-2 border-success-line pl-2 text-micro leading-4 text-ink-muted">Will be labeled “1stSeen forecast” in Google Calendar, not a confirmed date.</p>}</div></label>; })}</div></div>
      <div className="border-t border-line bg-surface-sunken p-4">{message && <p className="mb-3 text-micro leading-4 text-ink-muted">{message}</p>}<Button disabled={!status?.connected || selected.length === 0 || busy} onClick={sync} className="w-full gap-2 bg-accent text-ink-inverse">{busy ? <Icon name="loader-circle" size={14} className="animate-spin" /> : <Icon name="refresh-cw" size={14} />}Sync {selected.length || "selected"} event{selected.length === 1 ? "" : "s"}</Button>{status?.connected && <div className="mt-3 grid grid-cols-2 gap-2"><button disabled={busy} onClick={() => void disconnect(false)} className="flex h-8 items-center justify-center gap-1.5 rounded border border-line text-micro font-semibold text-ink-muted"><Icon name="log-out" size={11} />Disconnect, keep events</button><button disabled={busy} onClick={() => void disconnect(true)} className="h-8 rounded border border-danger-line text-micro font-semibold text-danger-ink max-sm:h-touch">Disconnect & remove events</button></div>}</div></aside></>}
  </>;
}
