import { z } from "zod";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { hasSupabaseConfig } from "@/lib/config";
import {
  FIELD_VALUES,
  LOOKING_FOR_VALUES,
  MAX_COMPANIES,
  MAX_SEED_FOLLOWS,
  disciplinesForFields,
  planOutcome,
  type FieldValue,
} from "@/lib/onboarding";
import { requestReadinessPlan } from "@/lib/readiness-plan";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const answersSchema = z.object({
  looking_for: z.enum(LOOKING_FOR_VALUES as [string, ...string[]]).nullable(),
  fields: z.array(z.enum(FIELD_VALUES as [string, ...string[]])).max(FIELD_VALUES.length),
  companies: z.array(z.string().uuid()).max(MAX_COMPANIES),
}).strict();

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("complete"),
    answers: answersSchema,
    role_ids: z.array(z.string().uuid()).max(MAX_SEED_FOLLOWS),
  }).strict(),
  z.object({ action: z.literal("skip") }).strict(),
]);

type FactRow = { role_id: string; forecastable: boolean; window_end: string | null };

/**
 * Finish or skip the first run.
 *
 * The user is the Supabase session and nothing else. Preferences and follows are written with the user's own client,
 * so the table's RLS policies apply to every write. The service role is used only to read which of the chosen roles
 * are in scope and have a current forecast, and which chosen companies exist. Finishing follows the chosen roles and
 * companies, asks the worker for a readiness plan on the first chosen role with a current forecast, and says where to
 * land; a plan that cannot be built is reported, never faked. A guest's answers arrive here the same way, after sign-up.
 *
 * Only the fields are stored as preferences, as the disciplines they cover: the program type has no column, and the roles
 * followed carry it. Answers
 * an earlier first run stored (graduation year, season, places) are left as they are.
 */
export async function POST(request: Request) {
  if (!hasSupabaseConfig() || !hasServiceRoleConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return json({ error: "unauthorized" }, 401);
  const userId = auth.user.id;
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "invalid_onboarding_request" }, 400);
  const now = new Date();

  if (parsed.data.action === "skip") {
    const skipped = await supabase
      .from("recruiting_preferences")
      .upsert({ user_id: userId, onboarding_skipped_at: now.toISOString() }, { onConflict: "user_id" });
    if (skipped.error) return json({ error: "onboarding_save_failed" }, 500);
    return json({ status: "skipped", redirect: "/roles" });
  }

  const { answers } = parsed.data;
  const saved = await supabase.from("recruiting_preferences").upsert(
    {
      user_id: userId,
      target_disciplines: disciplinesForFields(answers.fields as FieldValue[]),
      onboarding_completed_at: now.toISOString(),
      onboarding_skipped_at: null,
    },
    { onConflict: "user_id" },
  );
  if (saved.error) return json({ error: "onboarding_save_failed" }, 500);

  const companies = [...new Set(answers.companies.map((id) => id.toLowerCase()))];
  if (companies.length) {
    // bounded: at most MAX_COMPANIES (10) rows by primary key, from the request schema.
    const known = await createAdminClient().from("companies").select("id").in("id", companies);
    if (known.error) return json({ error: "company_lookup_failed" }, 500);
    const existing = new Set((known.data as { id: string }[]).map((row) => row.id));
    // bounded: at most MAX_COMPANIES (10) rows, filtered to the requested companies.
    const followed = await supabase
      .from("watchlist_items")
      .select("company_id")
      .eq("user_id", userId)
      .eq("target_type", "company")
      .in("company_id", companies);
    if (followed.error) return json({ error: "follow_failed" }, 500);
    const already = new Set((followed.data as { company_id: string }[]).map((row) => row.company_id));
    const fresh = companies.filter((id) => existing.has(id) && !already.has(id));
    if (fresh.length) {
      const inserted = await supabase
        .from("watchlist_items")
        .insert(fresh.map((id) => ({ user_id: userId, target_type: "company", company_id: id, alerts_enabled: true })));
      if (inserted.error) return json({ error: "follow_failed" }, 500);
    }
  }

  const requested = [...new Set(parsed.data.role_ids)];
  if (requested.length === 0) {
    return json({ status: "completed", watching: 0, plan: null, redirect: companies.length ? "/roles?watched=1" : "/roles" });
  }

  // bounded: filtered to the requested ids, at most MAX_SEED_FOLLOWS (12) by the request schema.
  const facts = await createAdminClient()
    .rpc("dashboard_role_facts", { p_now: now.toISOString(), p_user_id: null })
    .in("role_id", requested)
    .select("role_id,forecastable,window_end");
  if (facts.error) return json({ error: "role_lookup_failed" }, 500);
  const factById = new Map((facts.data as FactRow[]).map((row) => [row.role_id, row]));
  // A role outside the product scope is not in the facts, so it cannot be followed from here.
  const chosen = requested.filter((id) => factById.has(id));
  if (chosen.length === 0) return json({ error: "no_in_scope_roles" }, 400);

  // bounded: filtered to the chosen ids, at most MAX_SEED_FOLLOWS (12).
  const existing = await supabase
    .from("watchlist_items")
    .select("canonical_role_id")
    .eq("user_id", userId)
    .eq("target_type", "canonical_role")
    .in("canonical_role_id", chosen);
  if (existing.error) return json({ error: "follow_failed" }, 500);
  const alreadyFollowed = new Set((existing.data as { canonical_role_id: string }[]).map((row) => row.canonical_role_id));
  const fresh = chosen.filter((id) => !alreadyFollowed.has(id));
  if (fresh.length) {
    const inserted = await supabase
      .from("watchlist_items")
      .insert(fresh.map((id) => ({ user_id: userId, target_type: "canonical_role", canonical_role_id: id, alerts_enabled: true })));
    if (inserted.error) return json({ error: "follow_failed" }, 500);
  }

  const today = now.toISOString().slice(0, 10);
  const landing = chosen.find((id) => {
    const fact = factById.get(id)!;
    return fact.forecastable && fact.window_end !== null && fact.window_end >= today;
  });
  if (!landing) {
    return json({ status: "completed", watching: chosen.length, plan: null, redirect: "/roles?watched=1&welcome=none" });
  }
  const plan = planOutcome((await requestReadinessPlan(userId, landing)).status);
  return json({ status: "completed", watching: chosen.length, plan, redirect: `/roles/${landing}?welcome=${plan}` });
}
