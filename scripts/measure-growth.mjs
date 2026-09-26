#!/usr/bin/env node
/**
 * Per-day database growth, derived from history instead of sampled once a day.
 *
 * Sampling `pg_database_size` daily gives one data point per day, so confirming a growth projection takes a week. The
 * database already knows the answer: every counted table carries an insertion timestamp, so rows added per day is a
 * fact about the past, and each table's current bytes per row turns those rows into megabytes.
 *
 * Both reads are single bounded RPCs (migration 202608140054), so this costs two requests whatever the corpus size.
 *
 * What this is and is not:
 *   - Rows per day are MEASURED, exactly, from the timestamp columns.
 *   - Bytes per row is TODAY'S average for that table, including its indexes and TOAST, because that is what consumes
 *     the ceiling. It is applied backwards, so a table whose rows changed size over the window is approximated, and
 *     bloat not yet vacuumed inflates it. Megabytes per day is therefore a DERIVATION, not a measurement.
 *   - The first and last days in the window are partial and are dropped; a day with no rows anywhere is dropped too,
 *     because that is a day collection did not run, not a day it grew by zero.
 *
 * Usage: node scripts/measure-growth.mjs [--days N] [--json]
 */

import { loadDotEnv, requireEnv } from "./lib/db.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const DAYS = Math.min(90, Math.max(2, Number(argv[argv.indexOf("--days") + 1]) || 14));
const AS_JSON = argv.includes("--json");
const CEILING_BYTES = 8 * 1024 * 1024 * 1024;
const TRIPWIRE_BYTES = 4.8 * 1024 * 1024 * 1024;

const restBase = `${requireEnv("SUPABASE_URL").replace(/\/+$/, "")}/rest/v1`;
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

async function rpc(name, params) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${restBase}/rpc/${name}?${query}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  // The function name is enough to act on; the URL and any response body are not echoed.
  if (!response.ok) throw new Error(`read of rpc/${name} failed with HTTP ${response.status}`);
  return response.json();
}

const mib = (bytes) => bytes / 1024 / 1024;
const round = (value, digits = 2) => Number(value.toFixed(digits));

async function main() {
  const [daily, totals] = await Promise.all([
    rpc("counted_table_daily_rows", { p_days: String(DAYS) }),
    rpc("counted_table_totals", { p_since: new Date().toISOString() }),
  ]);

  const size = new Map(totals.map((row) => [row.table_name, { total: Number(row.total), bytes: Number(row.total_bytes) }]));
  const databaseBytes = Number(totals[0]?.database_bytes ?? 0);

  // Which days the window actually observed, so partial ends can be dropped by date rather than by assumption.
  const days = [...new Set(daily.map((row) => row.day))].sort();
  const complete = days.slice(1, -1);
  if (complete.length === 0) {
    process.stderr.write(`measure-growth: ${days.length} day(s) of history in the last ${DAYS}; need at least 3\n`);
    process.exitCode = 1;
    return;
  }

  const perTable = [...size.keys()]
    .map((table) => {
      const rowsByDay = new Map(daily.filter((row) => row.table_name === table).map((row) => [row.day, Number(row.rows)]));
      const observed = complete.map((day) => rowsByDay.get(day) ?? 0);
      const active = observed.filter((count) => count > 0);
      const entry = size.get(table);
      const bytesPerRow = entry.total > 0 ? entry.bytes / entry.total : 0;
      const rowsPerDay = active.length ? active.reduce((sum, n) => sum + n, 0) / active.length : 0;
      return {
        table,
        rows_total: entry.total,
        bytes_per_row: Math.round(bytesPerRow),
        days_with_rows: active.length,
        rows_per_active_day: Math.round(rowsPerDay),
        mib_per_active_day: round(mib(rowsPerDay * bytesPerRow)),
      };
    })
    .sort((a, b) => b.mib_per_active_day - a.mib_per_active_day);

  // The per-day series, not just the window average: the point of measuring growth here is to see the day a fix landed,
  // and an average over the window would hide exactly that. A day every table missed is a day collection did not run.
  const bytesPerRow = new Map(perTable.map((row) => [row.table, row.bytes_per_row]));
  const series = complete
    .map((day) => {
      const rows = daily.filter((row) => row.day === day);
      const written = rows.reduce((sum, row) => sum + Number(row.rows), 0);
      return {
        day,
        rows: written,
        mib: round(rows.reduce((sum, row) => sum + Number(row.rows) * (bytesPerRow.get(row.table_name) ?? 0), 0) / 1024 / 1024),
      };
    })
    .filter((entry) => entry.rows > 0);

  const totalPerDay = perTable.reduce((sum, row) => sum + row.mib_per_active_day, 0);
  const headroom = (limit) => (totalPerDay > 0 ? Math.floor(mib(limit - databaseBytes) / totalPerDay) : null);
  const summary = {
    window_days: DAYS,
    days_observed: days.length,
    complete_days: complete.length,
    first_complete_day: complete[0],
    last_complete_day: complete[complete.length - 1],
    database_mib: round(mib(databaseBytes), 1),
    derived_mib_per_active_day: round(totalPerDay),
    days_to_tripwire_4_8_gib: headroom(TRIPWIRE_BYTES),
    days_to_ceiling_8_gib: headroom(CEILING_BYTES),
    // The most recent complete day that wrote anything: the rate to quote once a fix has had a full day.
    latest_day_mib: series.length ? series[series.length - 1].mib : null,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify({ summary, per_day: series, tables: perTable }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Growth derived from ${complete.length} complete day(s), ${summary.first_complete_day} to ${summary.last_complete_day}.\n`);
  process.stdout.write(`Rows per day are measured; megabytes per day is derived from today's bytes per row.\n\n`);
  const pad = (value, width, left = false) => (left ? String(value).padEnd(width) : String(value).padStart(width));
  process.stdout.write(`${pad("table", 26, true)} ${pad("rows", 9)} ${pad("B/row", 8)} ${pad("days", 5)} ${pad("rows/day", 9)} ${pad("MiB/day", 9)}\n`);
  process.stdout.write(`${"-".repeat(26)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(5)} ${"-".repeat(9)} ${"-".repeat(9)}\n`);
  for (const row of perTable) {
    if (row.mib_per_active_day === 0 && row.rows_per_active_day === 0) continue;
    process.stdout.write(
      `${pad(row.table, 26, true)} ${pad(row.rows_total, 9)} ${pad(row.bytes_per_row, 8)} ${pad(row.days_with_rows, 5)} ${pad(row.rows_per_active_day, 9)} ${pad(row.mib_per_active_day, 9)}\n`,
    );
  }
  process.stdout.write(`\n${pad("derived total", 26, true)} ${pad("", 9)} ${pad("", 8)} ${pad("", 5)} ${pad("", 9)} ${pad(summary.derived_mib_per_active_day, 9)} MiB/day\n`);
  process.stdout.write(`\nPer day, days nothing was written omitted:\n`);
  for (const entry of series) {
    process.stdout.write(`  ${entry.day}  ${String(entry.rows).padStart(8)} rows  ${String(entry.mib).padStart(8)} MiB\n`);
  }
  process.stdout.write(`\nDatabase is ${summary.database_mib} MiB. At that rate: ${summary.days_to_tripwire_4_8_gib} day(s) to the 4.8 GiB tripwire, ${summary.days_to_ceiling_8_gib} to the 8 GiB ceiling.\n`);
}

main().catch((error) => {
  process.stderr.write(`measure-growth failed: ${error.message}\n`);
  process.exitCode = 1;
});
