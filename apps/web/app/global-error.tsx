"use client";

/**
 * A failure in the root layout itself, which replaces the whole document, stylesheet included.
 *
 * It deliberately imports no stylesheet: importing one made the build emit a second copy of the whole stylesheet and
 * link it from every page, which cost every visitor a render-blocking request. This page is rare and has to work with
 * no CSS at all, so it carries its few styles inline.
 */
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#f2f1ec", color: "#16231f", fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }}>
        <main style={{ maxWidth: "32rem", margin: "0 auto", padding: "6rem 1.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.75rem", lineHeight: 1.2, margin: 0 }}>Well, that tripped us up.</h1>
          <p style={{ margin: "0.75rem 0 2rem", fontSize: "1rem", lineHeight: 1.6, color: "#4a5a54" }}>
            Something broke on our side. Give it a minute and try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ minHeight: "44px", padding: "0 1.75rem", borderRadius: "999px", border: 0, background: "#1b3a31", color: "#f7f6f1", fontSize: "1rem", fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
          <p style={{ marginTop: "1rem" }}>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- the router is part of what failed; this reloads the page */}
            <a href="/" style={{ color: "#4a5a54", fontSize: "0.875rem" }}>Go home</a>
          </p>
        </main>
      </body>
    </html>
  );
}
