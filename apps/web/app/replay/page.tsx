import type { Metadata } from "next";
import { ForecastReplay } from "@/components/forecast-replay";
import { SiteHeader } from "@/components/site-header";
import { loadReplayCandidates } from "@/lib/real-data";
import { parseReplayFilters, replayHref } from "@/lib/replay-query";

export const metadata: Metadata = {
  title: "Forecast Replay",
  description: "Reconstruct a historical opening forecast using only evidence available at its cutoff.",
};

// Candidate cycles change as collection reconstructs history.
export const dynamic = "force-dynamic";

export default async function ReplayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Company, search, precision, backtest outcome, and page are URL state, so every
  // filtered view is a server render of exactly the candidates it shows.
  const filters = parseReplayFilters(await searchParams);
  const data = await loadReplayCandidates(filters);
  // Keyed by the URL so the selected target and cutoff reset with each page or filter.
  return (
    <>
      <SiteHeader active="replay" contentId="replay-content" />
      <ForecastReplay key={replayHref(filters)} data={data} />
    </>
  );
}
