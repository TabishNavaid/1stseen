import "server-only";

import { createPublicReader } from "@/lib/public-read";
import { hasServiceRoleConfig, loadLatestBacktest, type ReplayBacktestReasons } from "@/lib/real-data";

/** Scored-case metrics of a backtest run, as BacktestRunner computed them; every one is null until a case is scored. */
export type BacktestMetrics = {
  caseCount: number;
  intervalCoverage: number | null;
  medianAbsoluteErrorDays: number | null;
  meanAbsoluteErrorDays: number | null;
  averageIntervalWidthDays: number | null;
};

/** In-scope roles by the recruiting cycles of their own behind today's forecast. */
export type ForecastDepth = {
  inScopeRoles: number;
  withForecast: number;
  /** Forecasts resting on no cycle of the program's own, then one, two, and three or more. */
  byOwnCycles: [number, number, number, number];
  withoutForecast: number;
};

export type MethodologyData = {
  backtest: (ReplayBacktestReasons & { metrics: BacktestMetrics }) | null;
  depth: ForecastDepth;
};

const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * What the methodology page states as the current position: the latest persisted backtest, with its own skip
 * reasons and metrics, and how much history today's forecasts rest on. Read through the public reader, so a guest and
 * a signed-in reader see the same page; null when no database is configured, because nothing here has a fixture.
 */
export async function loadMethodologyData(now: Date = new Date()): Promise<MethodologyData | null> {
  if (!hasServiceRoleConfig()) return null;
  const reader = createPublicReader();
  const [backtest, depthResult] = await Promise.all([
    loadLatestBacktest(reader),
    // bounded: grouped by cycles capped at three, so at most five rows (0-3 and no forecast).
    reader.rpc("forecast_history_depth", { p_now: now.toISOString() }),
  ]);
  if (depthResult.error) throw new Error("methodology_read_failed");

  const byOwnCycles: [number, number, number, number] = [0, 0, 0, 0];
  let withoutForecast = 0;
  for (const row of (depthResult.data ?? []) as { history_count: number | null; roles: number | string }[]) {
    if (row.history_count === null) withoutForecast += Number(row.roles);
    else byOwnCycles[Math.min(3, Math.max(0, Number(row.history_count)))] += Number(row.roles);
  }
  const withForecast = byOwnCycles.reduce((total, count) => total + count, 0);

  let metrics: BacktestMetrics = {
    caseCount: 0, intervalCoverage: null, medianAbsoluteErrorDays: null, meanAbsoluteErrorDays: null, averageIntervalWidthDays: null,
  };
  if (backtest) {
    // bounded: one row, the run by its primary key.
    const run = await reader.from("backtest_runs", "id,aggregate_metrics").eq("id", backtest.runId).maybeSingle();
    if (run.error) throw new Error("methodology_read_failed");
    const aggregate = (run.data?.aggregate_metrics ?? {}) as Record<string, unknown>;
    metrics = {
      caseCount: Number(aggregate.case_count ?? 0),
      intervalCoverage: number(aggregate.interval_coverage),
      medianAbsoluteErrorDays: number(aggregate.median_absolute_error_days),
      meanAbsoluteErrorDays: number(aggregate.mean_absolute_error_days),
      averageIntervalWidthDays: number(aggregate.average_interval_width_days),
    };
  }

  return {
    backtest: backtest ? { ...backtest, metrics } : null,
    depth: { inScopeRoles: withForecast + withoutForecast, withForecast, byOwnCycles, withoutForecast },
  };
}
