import "server-only";

import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "@/lib/account/policy";
import { createPublicReader } from "@/lib/public-read";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll, fetchAllIn } from "@/lib/supabase/paging";

/**
 * What one account holds, read for its export (GET /api/account/export) and for the deletion dialog.
 *
 * Every user-owned read uses the service role with an explicit filter on the session's user id, the way the other
 * loaders do; the id never comes from a request. Each select names its columns, so neither an OAuth token nor its
 * ciphertext is ever read here, let alone exported. `tests/integration/account-deletion.test.mjs` fails when a table
 * that can hold a user id is missing from `tables`.
 */

type Row = Record<string, unknown>;

/** The tables whose rows carry the owner's id directly, the columns exported from each, and a stable paging order. */
const OWNED_TABLES = {
  profiles: { owner: "id", order: "id", columns: "display_name,timezone,created_at,updated_at" },
  recruiting_preferences: {
    owner: "user_id",
    order: "user_id",
    columns:
      "target_disciplines,target_role_families,graduation_year,target_recruiting_season,preferred_locations,company_size_preferences,onboarding_completed_at,onboarding_skipped_at,created_at,updated_at",
  },
  watchlist_items: {
    owner: "user_id",
    order: "id",
    columns: "id,target_type,company_id,canonical_role_id,role_family,track,alerts_enabled,created_at,updated_at",
  },
  watchlists: { owner: "user_id", order: "canonical_role_id", columns: "canonical_role_id,alerts_enabled,alert_lead_days,created_at,updated_at" },
  priority_companies: { owner: "user_id", order: "company_id", columns: "company_id,priority,created_at,updated_at" },
  readiness_milestones: {
    owner: "user_id",
    order: "id",
    columns:
      "id,canonical_role_id,forecast_id,kind,due_on,ideal_due_on,lead_days,policy_version,rationale,adjustments,window_start,window_end,completed_at,created_at,updated_at",
  },
  calendar_event_syncs: {
    owner: "user_id",
    order: "id",
    columns:
      "id,provider,source_kind,source_key,canonical_role_id,readiness_milestone_id,forecast_id,google_calendar_id,google_event_id,event_fingerprint,status,last_synced_at,last_error_code,created_at,updated_at",
  },
  email_digest_deliveries: {
    owner: "user_id",
    order: "id",
    columns:
      "id,channel,digest_version,period_start,period_end,as_of,input_fingerprint,recipient_email,subject,structured_payload,rendered_html,status,external_message_id,attempted_at,sent_at,failure_code,created_at,updated_at",
  },
  // Connection status only. The two *_token_ciphertext columns and token_expires_at are deliberately not selected.
  google_calendar_connections: {
    owner: "user_id",
    order: "user_id",
    columns: "calendar_id,google_account_label,scopes,connected_at,updated_at,last_error_code,last_error_at",
  },
  gmail_connections: {
    owner: "user_id",
    order: "user_id",
    columns: "google_account_email,scopes,connected_at,updated_at,last_error_code,last_error_at",
  },
} as const;

type OwnedTable = keyof typeof OWNED_TABLES;

export type AccountIdentity = {
  id: string;
  email?: string | null;
  created_at?: string | null;
  email_confirmed_at?: string | null;
  last_sign_in_at?: string | null;
};

export type AccountExport = {
  format: typeof EXPORT_FORMAT;
  format_version: typeof EXPORT_FORMAT_VERSION;
  exported_at: string;
  about: string;
  account: { id: string; email: string | null; created_at: string | null; email_confirmed_at: string | null; last_sign_in_at: string | null };
  tables: Record<OwnedTable | "email_digest_items" | "agent_runs" | "agent_tool_calls" | "model_usage", Row[]>;
  referenced_roles: Array<{ id: string; company: string | null; title: string | null }>;
  referenced_companies: Array<{ id: string; name: string | null }>;
};

const ABOUT =
  "Everything 1stSeen stores for this account, one key per database table under `tables`. Google connections are listed " +
  "by status (account, scopes, when connected); the OAuth tokens themselves are never exported. `agent_runs` are the " +
  "questions this account asked the recruiting agent, with the answer state 1stSeen stored. `referenced_roles` and " +
  "`referenced_companies` name the public roles and companies the rows point at.";

export async function buildAccountExport(identity: AccountIdentity, now = new Date()): Promise<AccountExport> {
  const admin = createAdminClient();
  const userId = identity.id;

  const owned = async (table: OwnedTable): Promise<Row[]> => {
    const { owner, order, columns }: { owner: string; order: string; columns: string } = OWNED_TABLES[table];
    // Typed as plain records: supabase-js's select parser does not terminate on a union of column lists. `order` is unique
    // within one owner's rows, so it is the paging key.
    return fetchAll<Row>(() => admin.from(table).select<string, Row>(columns).eq(owner, userId), `${table}_export`, order);
  };
  const tableNames = Object.keys(OWNED_TABLES) as OwnedTable[];
  const ownedRows = Object.fromEntries(
    await Promise.all(tableNames.map(async (table) => [table, await owned(table)] as const)),
  ) as Record<OwnedTable, Row[]>;
  for (const table of ["google_calendar_connections", "gmail_connections"] as const) {
    ownedRows[table] = ownedRows[table].map((row) => ({ connected: true, ...row }));
  }

  const deliveryIds = ownedRows.email_digest_deliveries.map((row) => String(row.id));
  const digestItems = await fetchAllIn<Row>(
    (ids) => admin.from("email_digest_items").select("id,delivery_id,item_key,kind,canonical_role_id,forecast_id,forecast_change_id,historical_opening_event_id,readiness_milestone_id,event_on,payload,created_at").in("delivery_id", ids),
    deliveryIds,
    "email_digest_items_export",
    "id",
  );

  // Which runs are the account's is decided once, in SQL (migration 202608140037), for the export and the deletion alike.
  const runIds = (
    await fetchAll<{ run_id: string }>(() => admin.rpc("account_agent_run_ids", { p_user_id: userId }), "account_agent_run_ids", "run_id")
  ).map((row) => row.run_id);
  const [runs, toolCalls, modelUsage] = await Promise.all([
    fetchAllIn<Row>((ids) => admin.from("agent_runs").select("id,purpose,status,started_at,finished_at,error,metadata").in("id", ids), runIds, "agent_runs_export", "id"),
    fetchAllIn<Row>(
      (ids) => admin.from("agent_tool_calls").select("id,agent_run_id,tool_name,status,input_redacted,output_redacted,started_at,finished_at,error").in("agent_run_id", ids),
      runIds,
      "agent_tool_calls_export",
      "id",
    ),
    fetchAllIn<Row>(
      (ids) => admin.from("model_usage").select("id,agent_run_id,tool_call_id,capability,provider,model,success,failure_kind,prompt_tokens,completion_tokens,estimated_cost_usd,latency_ms,created_at").in("agent_run_id", ids),
      runIds,
      "model_usage_export",
      "id",
    ),
  ]);
  const questions = runs
    .map(({ metadata, started_at: askedAt, ...run }) => {
      const state = (metadata as { state?: Row } | null)?.state ?? null;
      return { ...run, asked_at: askedAt, question: typeof state?.goal === "string" ? state.goal : null, stored_state: state };
    })
    .sort((a, b) => String(a.asked_at).localeCompare(String(b.asked_at)));

  const tables = { ...ownedRows, email_digest_items: digestItems, agent_runs: questions, agent_tool_calls: toolCalls, model_usage: modelUsage };
  const { roles, companies } = await referencedNames(tables);

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    about: ABOUT,
    account: {
      id: userId,
      email: identity.email ?? null,
      created_at: identity.created_at ?? null,
      email_confirmed_at: identity.email_confirmed_at ?? null,
      last_sign_in_at: identity.last_sign_in_at ?? null,
    },
    tables,
    referenced_roles: roles,
    referenced_companies: companies,
  };
}

/**
 * Names for the public roles and companies an export points at, so a person can read it without looking ids up. Read
 * through the public reader like every non-user read. Not a product surface: a followed role that has since left the
 * product's scope is still named, because the row that points at it is the user's.
 */
async function referencedNames(tables: Record<string, Row[]>) {
  const roleIds = new Set<string>();
  const companyIds = new Set<string>();
  for (const rows of Object.values(tables)) {
    for (const row of rows) {
      if (typeof row.canonical_role_id === "string") roleIds.add(row.canonical_role_id);
      if (typeof row.company_id === "string") companyIds.add(row.company_id);
    }
  }
  const reader = createPublicReader();
  const roleRows = await fetchAllIn<Row>((ids) => reader.from("canonical_roles", "id,company_id,canonical_title").in("id", ids), [...roleIds].sort(), "referenced_roles", "id");
  for (const row of roleRows) if (typeof row.company_id === "string") companyIds.add(row.company_id);
  const companyRows = await fetchAllIn<Row>((ids) => reader.from("companies", "id,name").in("id", ids), [...companyIds].sort(), "referenced_companies", "id");
  const companyName = new Map(companyRows.map((row) => [String(row.id), typeof row.name === "string" ? row.name : null]));
  return {
    roles: roleRows.map((row) => ({
      id: String(row.id),
      company: companyName.get(String(row.company_id)) ?? null,
      title: typeof row.canonical_title === "string" ? row.canonical_title : null,
    })),
    companies: [...companyName].map(([id, name]) => ({ id, name })),
  };
}

export type GoogleConnectionSummary = { calendarConnected: boolean; gmailConnected: boolean; activeSyncedEvents: number };

/** What the deletion dialog needs to say about Google: which connections exist, and how many events are synced. */
export async function loadGoogleConnectionSummary(userId: string): Promise<GoogleConnectionSummary> {
  const admin = createAdminClient();
  const [calendar, gmail, synced] = await Promise.all([
    // bounded: head:true returns a count and no rows.
    admin.from("google_calendar_connections").select("user_id", { count: "exact", head: true }).eq("user_id", userId),
    // bounded: head:true returns a count and no rows.
    admin.from("gmail_connections").select("user_id", { count: "exact", head: true }).eq("user_id", userId),
    // bounded: head:true returns a count and no rows.
    admin.from("calendar_event_syncs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("provider", "google").eq("status", "active"),
  ]);
  if (calendar.error || gmail.error || synced.error) throw new Error("google_connection_summary_failed");
  return { calendarConnected: (calendar.count ?? 0) > 0, gmailConnected: (gmail.count ?? 0) > 0, activeSyncedEvents: synced.count ?? 0 };
}
