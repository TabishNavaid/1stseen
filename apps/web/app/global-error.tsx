"use client";

import "./globals.css";
import { BrokenPage } from "@/components/broken-page";

/** A failure in the root layout itself, which replaces the whole document. */
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col antialiased">
        <BrokenPage reset={reset} />
      </body>
    </html>
  );
}
