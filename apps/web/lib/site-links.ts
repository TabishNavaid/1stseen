/**
 * The pages every page's footer links to. One list, so the footer, the pages themselves, and the tests agree
 * on where each lives.
 */
export const SITE_PAGES = [
  { key: "methodology", href: "/methodology", label: "Methodology and accuracy" },
  { key: "data-sources", href: "/data-sources", label: "Data sources" },
  { key: "terms", href: "/terms", label: "Terms" },
  { key: "privacy", href: "/privacy", label: "Privacy" },
  { key: "google-data", href: "/privacy/google", label: "Google data use" },
  { key: "contact", href: "/contact", label: "Contact" },
] as const;

export type SitePageKey = (typeof SITE_PAGES)[number]["key"];

export function sitePage(key: SitePageKey): (typeof SITE_PAGES)[number] {
  return SITE_PAGES.find((page) => page.key === key)!;
}

/**
 * The pages this deployment publishes. The data-sources page carries the takedown procedure, which works only through a
 * contact address that receives mail, so it is published only once FIRSTSEEN_CONTACT_EMAIL is set; the owner sets it
 * after confirming mail to it arrives (docs/takedown.md). Until then the page answers 404 and nothing links to it.
 */
export function publishedSitePages(contactConfigured: boolean): ReadonlyArray<(typeof SITE_PAGES)[number]> {
  return SITE_PAGES.filter((page) => page.key !== "data-sources" || contactConfigured);
}
