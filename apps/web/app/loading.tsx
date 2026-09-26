/**
 * The wait between one page and the next.
 *
 * It draws a bar and nothing else. A skeleton has to be the shape of what follows or it is worse than nothing, and
 * one fallback serves every route here — the landing page, a list, a program, a calendar — which are not one shape.
 * So this claims nothing, and each page fades itself in when it arrives.
 */
export default function Loading() {
  return (
    <main className="flex-1 bg-canvas" aria-busy="true">
      <span className="page-progress" aria-hidden="true" />
      <p role="status" className="sr-only">Loading</p>
    </main>
  );
}
