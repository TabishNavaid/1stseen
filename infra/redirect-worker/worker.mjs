/**
 * Sends every request on a secondary hostname to the same path and query on the primary one, permanently.
 *
 * The web app serves exactly one origin. Its session cookies are host-only, its auth emails and OAuth callbacks name
 * NEXT_PUBLIC_APP_URL, and the guest cache is keyed by origin, so a second hostname serving the app would sign users in
 * on one host and send them to the other. Redirecting keeps one origin (docs/deployment.md, "Custom domain").
 */
export const PRIMARY_ORIGIN = "https://1stseen.win";

export function redirectTarget(requestUrl) {
  const url = new URL(requestUrl);
  return `${PRIMARY_ORIGIN}${url.pathname}${url.search}`;
}

export default {
  fetch(request) {
    return Response.redirect(redirectTarget(request.url), 301);
  },
};
