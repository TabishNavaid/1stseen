import {
  followTargetSchema,
  recruitingPreferencesSchema,
  type FollowTarget,
} from "@firstseen/shared";
import { z } from "zod";
import { hasSupabaseConfig } from "@/lib/config";
import { fetchAll } from "@/lib/supabase/paging";
import { createClient } from "@/lib/supabase/server";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("follow"), target: followTargetSchema }).strict(),
  z.object({ action: z.literal("unfollow"), item_id: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("preferences"),
    preferences: recruitingPreferencesSchema,
  }).strict(),
]);

export async function GET() {
  const context = await authenticatedContext();
  if (context instanceof Response) return context;
  const { supabase, userId } = context;
  // Every follow and every priority: this is the user's own copy of what they set, so none may be dropped by the row cap.
  const [follows, preferences, priorities] = await Promise.all([
    fetchAll<Record<string, unknown>>(() => supabase.from("watchlist_items").select("*").eq("user_id", userId), "watchlist_items", "id")
      .then((data) => ({ data, error: null })),
    // bounded: one row; recruiting_preferences is keyed by user_id.
    supabase.from("recruiting_preferences").select("*").eq("user_id", userId).maybeSingle(),
    fetchAll<Record<string, unknown>>(
      () => supabase
        .from("priority_companies")
        .select("company_id,priority")
        .eq("user_id", userId)
        .order("priority", { ascending: false }),
      "priority_companies",
      "company_id",
    ).then((data) => ({ data, error: null })),
  ]);
  const error = follows.error ?? preferences.error ?? priorities.error;
  if (error) return Response.json({ error: "personalization_read_failed" }, { status: 500 });
  return Response.json({
    user_id: userId,
    follows: follows.data ?? [],
    preferences: {
      target_role_families: preferences.data?.target_role_families ?? [],
      graduation_year: preferences.data?.graduation_year ?? null,
      target_recruiting_season: preferences.data?.target_recruiting_season ?? null,
      preferred_locations: preferences.data?.preferred_locations ?? [],
      company_size_preferences: preferences.data?.company_size_preferences ?? [],
      priority_companies: priorities.data ?? [],
    },
  });
}

export async function POST(request: Request) {
  const context = await authenticatedContext();
  if (context instanceof Response) return context;
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_personalization_request" }, { status: 400 });
  }
  const { supabase, userId } = context;
  if (parsed.data.action === "unfollow") {
    const result = await supabase
      .from("watchlist_items")
      .delete()
      .eq("user_id", userId)
      .eq("id", parsed.data.item_id);
    return result.error
      ? Response.json({ error: "unfollow_failed" }, { status: 500 })
      : new Response(null, { status: 204 });
  }
  if (parsed.data.action === "preferences") {
    const { priority_companies: priorityCompanies, ...preferences } = parsed.data.preferences;
    const saved = await supabase.from("recruiting_preferences").upsert(
      { user_id: userId, ...preferences },
      { onConflict: "user_id" },
    );
    if (saved.error) {
      return Response.json({ error: "preferences_update_failed" }, { status: 500 });
    }
    const cleared = await supabase.from("priority_companies").delete().eq("user_id", userId);
    if (cleared.error) {
      return Response.json({ error: "priority_update_failed" }, { status: 500 });
    }
    if (priorityCompanies.length) {
      const priorities = await supabase.from("priority_companies").insert(
        priorityCompanies.map((item) => ({ user_id: userId, ...item })),
      );
      if (priorities.error) {
        return Response.json({ error: "priority_update_failed" }, { status: 500 });
      }
    }
    return Response.json({ status: "saved" });
  }

  const target = parsed.data.target;
  const [targetField, targetValue] = followIdentity(target);
  // bounded: at most one row; each target type has a unique index on (user_id, its target column).
  const existing = await supabase
    .from("watchlist_items")
    .select("id")
    .eq("user_id", userId)
    .eq("target_type", target.target_type)
    .eq(targetField, targetValue)
    .maybeSingle();
  if (existing.error) {
    return Response.json({ error: "follow_lookup_failed" }, { status: 500 });
  }
  const result = existing.data
    ? await supabase
        .from("watchlist_items")
        .update({ alerts_enabled: target.alerts_enabled })
        .eq("user_id", userId)
        .eq("id", existing.data.id)
        .select("*")
        .single()
    : await supabase
        .from("watchlist_items")
        .insert({ user_id: userId, ...target })
        .select("*")
        .single();
  return result.error
    ? Response.json({ error: "follow_failed" }, { status: 500 })
    : Response.json(result.data, { status: existing.data ? 200 : 201 });
}

function followIdentity(target: FollowTarget) {
  switch (target.target_type) {
    case "company":
      return ["company_id", target.company_id] as const;
    case "canonical_role":
      return ["canonical_role_id", target.canonical_role_id] as const;
    case "role_family":
      return ["role_family", target.role_family] as const;
    case "track":
      return ["track", target.track] as const;
  }
}

async function authenticatedContext() {
  if (!hasSupabaseConfig()) {
    return Response.json({ error: "supabase_unavailable" }, { status: 503 });
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return { supabase, userId: data.user.id };
}
