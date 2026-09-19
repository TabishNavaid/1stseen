/**
 * The status a page's own body says it has.
 *
 * The root loading boundary (app/loading.tsx) sends the page shell with 200 before the page itself runs, so a page that
 * is not found, or that fails on the server, cannot set its own status: it used to answer 200. The Worker entry reads
 * the whole document instead and sets the status from what the page rendered:
 *
 * - a not-found page (components/missing-page.tsx) marks itself with `data-page-status="404"`;
 * - a boundary that failed on the server leaves React's error digest: `<template data-dgst="...">` when it failed
 *   before the boundary was sent, `$RX("B:0","...")` when it failed after (a slow read that gave up). A digest for
 *   notFound() is a 404, a redirect's or a deliberate client render's is not an error, and any other is a failure: 500.
 *
 * No marker can come from data: React writes text and attribute values with their quotes escaped, and the page's
 * inline data as escaped JSON, so a title containing any of these strings never reaches the page as the marker.
 *
 * A 404 or a 500 is never stored anywhere: it is sent `no-store`, and the guest edge cache keeps only a 200
 * (guest-cache.ts).
 */

export const NOT_FOUND_MARKER = 'data-page-status="404"';

export type PageStatus = 200 | 404 | 500;

function digests(html: string): string[] {
  const early = [...html.matchAll(/<template data-dgst="([^"]*)"/g)].map((match) => match[1]);
  const late = [...html.matchAll(/\$RX\("[^"]*","([^"]*)"/g)].map((match) => match[1]);
  return [...early, ...late];
}

export function pageStatus(html: string): PageStatus {
  if (html.includes(NOT_FOUND_MARKER)) return 404;
  for (const digest of digests(html)) {
    if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return 404;
    if (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("BAILOUT_TO_CLIENT_SIDE_RENDERING")) continue;
    return 500;
  }
  return 200;
}

const STATUS_TEXT: Record<PageStatus, string> = { 200: "OK", 404: "Not Found", 500: "Internal Server Error" };

function isDocument(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * A rendered document with the status its body states. Anything that is not an HTML document (a client navigation's
 * payload, an API answer, an event stream) passes through untouched, and so does a redirect. Every document that is
 * not a 200 is marked `no-store`.
 */
export async function withPageStatus(response: Response): Promise<Response> {
  if (!isDocument(response)) return response;
  if (response.status >= 300 && response.status < 400) return response;
  if (response.status !== 200) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const html = await response.text();
  const status = pageStatus(html);
  const headers = new Headers(response.headers);
  if (status !== 200) headers.set("cache-control", "no-store");
  return new Response(html, { status, statusText: status === 200 ? response.statusText : STATUS_TEXT[status], headers });
}
