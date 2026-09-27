import "server-only";

import type { CalendarEvent } from "@/lib/calendar-data";
import { isAvatar } from "@/lib/profile";
import { loadRealCalendar } from "@/lib/real-data";
import { createAdminClient } from "@/lib/supabase/admin";

export type StoredProfile = {
  displayName: string | null;
  avatar: string | null;
  school: string | null;
  githubHandle: string | null;
  linkedinHandle: string | null;
  graduationYear: number | null;
  memberSince: string;
};

/**
 * One person's own details. Read with the service role, filtered to exactly that user id, the same way the first
 * run's answers are: `authenticated` has no read or write path that needs widening for this (202608140038).
 */
export async function loadProfile(userId: string): Promise<StoredProfile> {
  const admin = createAdminClient();
  const [profile, preferences] = await Promise.all([
    // bounded: one row; profiles is keyed by id.
    admin.from("profiles").select("display_name,avatar,school,github_handle,linkedin_handle,created_at").eq("id", userId).maybeSingle(),
    // bounded: one row; recruiting_preferences is keyed by user_id.
    admin.from("recruiting_preferences").select("graduation_year").eq("user_id", userId).maybeSingle(),
  ]);
  if (profile.error) throw new Error("profile_read_failed");
  if (preferences.error) throw new Error("recruiting_preferences_read_failed");
  const row = profile.data as Record<string, unknown> | null;
  return {
    displayName: (row?.display_name as string | null) ?? null,
    // A name this deployment does not draw is not an error; the page simply draws no character.
    avatar: isAvatar(row?.avatar) ? (row.avatar as string) : null,
    school: (row?.school as string | null) ?? null,
    githubHandle: (row?.github_handle as string | null) ?? null,
    linkedinHandle: (row?.linkedin_handle as string | null) ?? null,
    graduationYear: (preferences.data as { graduation_year: number | null } | null)?.graduation_year ?? null,
    memberSince: (row?.created_at as string | null) ?? new Date().toISOString(),
  };
}

export type ProfileActivity = {
  watchedRoles: number;
  /** Watched programs the model has given a window. The rest are counted, never given an invented date. */
  withWindow: number;
  /** The next dated thing on this person's own calendar, whatever kind it is. */
  next: { date: string; label: string; company: string; role: string; semantics: CalendarEvent["semantics"]; href: string } | null;
  prepSteps: { total: number; done: number; overdue: number };
};

/**
 * What this person has done here, derived from the records their own calendar is built from: their follows, the
 * stored forecasts for them, and their persisted preparation milestones. Nothing is counted that is not also
 * shown somewhere, and a watched program with too little history is counted as watched and nothing more.
 */
export async function loadProfileActivity(userId: string, today = new Date()): Promise<ProfileActivity> {
  const calendar = await loadRealCalendar(userId);
  if (calendar.mode !== "real") {
    return { watchedRoles: 0, withWindow: 0, next: null, prepSteps: { total: 0, done: 0, overdue: 0 } };
  }
  const day = today.toISOString().slice(0, 10);
  const readiness = calendar.events.filter((event) => event.semantics === "readiness");
  const ahead = calendar.events.filter((event) => event.date >= day).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  return {
    watchedRoles: calendar.watchedRoleCount,
    withWindow: Math.max(0, calendar.watchedRoleCount - calendar.unforecastable.length),
    next: ahead
      ? { date: ahead.date, label: ahead.label, company: ahead.company, role: ahead.role, semantics: ahead.semantics, href: ahead.href }
      : null,
    prepSteps: {
      total: readiness.length,
      done: readiness.filter((event) => event.completed).length,
      overdue: readiness.filter((event) => !event.completed && event.date < day).length,
    },
  };
}

export type ProfileEdit = {
  avatar?: string | null;
  school?: string | null;
  githubHandle?: string | null;
  linkedinHandle?: string | null;
};

/** Writes one person's own row. The caller has already taken `userId` from the session; nothing reads a body for it. */
export async function saveProfile(userId: string, edit: ProfileEdit): Promise<void> {
  const columns: Record<string, string | null> = {};
  if ("avatar" in edit) columns.avatar = edit.avatar ?? null;
  if ("school" in edit) columns.school = edit.school ?? null;
  if ("githubHandle" in edit) columns.github_handle = edit.githubHandle ?? null;
  if ("linkedinHandle" in edit) columns.linkedin_handle = edit.linkedinHandle ?? null;
  if (Object.keys(columns).length === 0) return;
  const saved = await createAdminClient().from("profiles").update(columns).eq("id", userId).select("id");
  if (saved.error || (saved.data ?? []).length !== 1) throw new Error("profile_update_failed");
}

/** The graduation year lives with the first run's other answers, so it is written where that wrote it. */
export async function saveGraduationYear(userId: string, year: number | null): Promise<void> {
  const saved = await createAdminClient()
    .from("recruiting_preferences")
    .upsert({ user_id: userId, graduation_year: year }, { onConflict: "user_id" });
  if (saved.error) throw new Error("graduation_year_update_failed");
}
