"use client";

import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="grid flex-1 place-items-center bg-canvas p-6"><section className="panel max-w-md p-8 text-center" role="alert"><Icon name="triangle-alert" size={24} className="mx-auto text-warning-ink" /><h1 className="mt-4 text-lg font-semibold">Intelligence view unavailable</h1><p className="mt-2 text-sm leading-6 text-ink-muted">The forecast data could not be loaded. Your watchlist and evidence have not been changed.</p><Button onClick={reset} className="mt-5">Try again</Button></section></main>;
}
