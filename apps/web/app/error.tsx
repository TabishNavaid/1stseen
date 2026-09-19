"use client";

import { BrokenPage } from "@/components/broken-page";

/** A page that failed on the server or in the browser. The Worker entry answers the document 500. */
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <BrokenPage reset={reset} />;
}
