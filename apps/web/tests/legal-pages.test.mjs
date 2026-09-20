/**
 * The policy pages: terms, privacy, Google data use, data sources, and contact.
 *
 * Rendered through the built Worker exactly as rendered-html.test.mjs does, with no database. The Google page is checked
 * against the connect routes' own source, so it cannot name a scope the code does not request or miss one it does.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LEGAL_PAGES_ARE_DRAFTS } from "../lib/legal.ts";
import { SITE_PAGES, publishedSitePages } from "../lib/site-links.ts";

const CONTACT = "contact@firstseen.example";

async function render(pathname, env = {}) {
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    return await worker.fetch(
      new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The document without its inline RSC payload, which repeats every server-rendered string. */
const visible = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
const text = (html) => visible(html).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ ([,.;:])/g, "$1");

async function page(pathname, env) {
  const response = await render(pathname, env);
  assert.equal(response.status, 200, `${pathname} renders`);
  return { response, html: await response.text() };
}

const PAGES = [
  {
    path: "/terms",
    title: "Terms of Service",
    says: [
      /Every opening date on 1stSeen is a statistical prediction from public evidence\. It is not a guarantee\./,
      /Nothing on 1stSeen comes from the companies themselves/,
      /Nothing on 1stSeen is career, legal, or financial advice/,
      /not affiliated with, endorsed by, or sponsored by any company or program it lists/,
      /scrape, crawl, or bulk-download/,
      /including through the recruiting agent/,
      /resell, republish, or redistribute/,
      /choose Delete account and type the confirmation\. It cannot be undone\./,
      /may suspend or close an account that breaks these terms/,
      /not liable for any loss/,
      /the date at the top of this page changes with them/,
    ],
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    says: [
      /stores your email address and a one-way hash of your password, never the password itself/,
      /with any email address or phone number in it replaced, cut to its first 1,000 characters/,
      /encrypted with AES-256-GCM/,
      /sb-…-auth-token/,
      /firstseen_google_oauth_state/,
      /nothing in your browser's local storage, session storage, or IndexedDB/,
      /does not sell your data, shows no advertising, and runs no analytics or advertising trackers/,
      /Supabase[\s\S]*Cloudflare[\s\S]*Google Cloud Run/,
      /Download your data gives you a JSON file of everything your account owns/,
      /It deletes every record your account owns and deletes your sign-in\. That is 1stSeen's to guarantee, and nothing another service does can stop it\./,
      /Only Google can revoke that access, so 1stSeen cannot guarantee it\. If Google does not confirm, your account is deleted all the same/,
      /tells you to remove the access yourself at myaccount\.google\.com\/connections/,
    ],
  },
  {
    path: "/privacy/google",
    title: "Google data use",
    says: [
      /1stSeen's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements/,
      /view and edit events on all your calendars/,
      /That is broader than what 1stSeen does with it/,
      /It never lists, reads, or changes any other event/,
      /It can send mail only\. It cannot read, search, or delete your mail\./,
      /does not sell it, use it for advertising, or use it to train any AI model/,
      /The deletion never waits on Google: if Google does not confirm the revocation, your account is still deleted/,
    ],
  },
  {
    path: "/data-sources",
    title: "Data sources and takedown",
    says: [
      /Greenhouse, Lever, Ashby, and SmartRecruiters/,
      /Wayback Machine/,
      /Reddit is off by default/,
      /at least a quarter of a second apart/,
      /gives up after 20 seconds and reads at most 10 MB/,
      /1stSeenEvidenceBot\/0\.2/,
      /They remain their owners' trademarks/,
      /You get a reply within two business days/,
      /What was already collected is kept, out of sight of every page, unless you also ask for it to be erased/,
    ],
  },
  { path: "/contact", title: "Contact", says: [/What to write about/, /A request from a company to stop collection or to be removed/] },
];

for (const { path, title, says } of PAGES) {
  test(`${path} renders its title and says what it must`, async () => {
    // The data-sources page is published only with a contact address; every other page renders either way.
    const { response, html } = await page(path, { FIRSTSEEN_CONTACT_EMAIL: path === "/data-sources" ? CONTACT : undefined });
    assert.match(html, new RegExp(`<title>${title} · 1stSeen</title>`));
    const body = text(html);
    for (const statement of says) assert.match(body, statement, `${path}: ${statement}`);
    // A signed-out read of a policy page sets no cookie; the privacy policy lists every cookie 1stSeen does set.
    assert.equal(response.headers.get("set-cookie"), null, `${path} sets no cookie`);
    // The footer's one disclosure stays the only place it is said.
    assert.equal(visible(html).match(/not affiliated with or endorsed/g)?.length, 1, `${path} says the footer disclosure once`);
  });
}

test("the four policy pages carry the draft marker from one constant, and the contact page carries none", async () => {
  for (const path of ["/terms", "/privacy", "/privacy/google", "/data-sources"]) {
    const { html } = await page(path, { FIRSTSEEN_CONTACT_EMAIL: CONTACT });
    assert.equal(/Draft for review/.test(visible(html)), LEGAL_PAGES_ARE_DRAFTS, path);
  }
  assert.doesNotMatch(visible((await page("/contact")).html), /Draft for review/);
  assert.match(readFileSync(new URL("../lib/legal.ts", import.meta.url), "utf8"), /export const LEGAL_PAGES_ARE_DRAFTS = (true|false);/);
});

test("every link in the footer resolves to a page, with and without a contact address", async () => {
  for (const email of [CONTACT, undefined]) {
    const env = { FIRSTSEEN_CONTACT_EMAIL: email };
    const { html } = await page("/methodology", env);
    const at = visible(html).indexOf("Opening dates on 1stSeen");
    const footer = visible(html).slice(visible(html).lastIndexOf("<footer", at), visible(html).indexOf("</footer>", at));
    const hrefs = [...footer.matchAll(/href="(\/[^"#]*)"/g)].map((match) => match[1]);
    // The wordmark goes home; everything after it is the published pages and nothing else.
    assert.deepEqual([...new Set(hrefs)].sort(), ["/", ...publishedSitePages(Boolean(email)).map((item) => item.href)].sort());
    for (const href of hrefs) assert.equal((await render(href, env)).status, 200, `${href} resolves`);
  }
  assert.equal(SITE_PAGES.length, publishedSitePages(false).length + 1, "only the data-sources page waits for the address");
});

test("the takedown page is not published until a contact address is configured, and nothing links to it", async () => {
  assert.equal((await render("/data-sources", { FIRSTSEEN_CONTACT_EMAIL: undefined })).status, 404);
  for (const path of ["/", "/methodology", "/terms", "/privacy", "/privacy/google", "/contact"]) {
    const html = visible(await (await render(path, { FIRSTSEEN_CONTACT_EMAIL: undefined })).text());
    assert.doesNotMatch(html, /href="\/data-sources"/, `${path} links the unpublished takedown page`);
  }
  assert.match(visible((await page("/contact", { FIRSTSEEN_CONTACT_EMAIL: CONTACT })).html), /href="\/data-sources"/);
});

test("without FIRSTSEEN_CONTACT_EMAIL the contact page says none is configured, and the others point to it", async () => {
  const contact = text((await page("/contact", { FIRSTSEEN_CONTACT_EMAIL: undefined })).html);
  assert.match(contact, /No contact address is configured on this deployment\./);
  assert.doesNotMatch(contact, /mailto:|@firstseen/);
  for (const path of ["/terms", "/privacy", "/privacy/google"]) {
    const { html } = await page(path, { FIRSTSEEN_CONTACT_EMAIL: undefined });
    assert.match(text(html), /the address on the contact page/, path);
    assert.match(visible(html), /href="\/contact"/, path);
    assert.doesNotMatch(visible(html), /mailto:/, path);
  }
});

test("with FIRSTSEEN_CONTACT_EMAIL every page gives that one address", async () => {
  const contact = await page("/contact", { FIRSTSEEN_CONTACT_EMAIL: CONTACT });
  assert.match(visible(contact.html), new RegExp(`href="mailto:${CONTACT}"`));
  assert.doesNotMatch(text(contact.html), /No contact address is configured/);
  for (const path of ["/terms", "/privacy", "/privacy/google", "/data-sources"]) {
    const { html } = await page(path, { FIRSTSEEN_CONTACT_EMAIL: CONTACT });
    assert.match(visible(html), new RegExp(`href="mailto:${CONTACT}"`), path);
    assert.doesNotMatch(text(html), /the address on the contact page/, path);
  }
  // Something that is not one plain address is treated as unset, never shown.
  const malformed = text((await page("/contact", { FIRSTSEEN_CONTACT_EMAIL: "write to us" })).html);
  assert.match(malformed, /No contact address is configured/);
});

test("the Google page names every scope exactly as the connect routes request it, and no other", async () => {
  const requested = new Set();
  for (const route of ["google-calendar", "gmail"]) {
    const source = readFileSync(new URL(`../app/api/integrations/${route}/connect/route.ts`, import.meta.url), "utf8");
    const scope = /\bscope:\s*"([^"]+)"/.exec(source);
    assert.ok(scope, `${route} connect route requests a scope`);
    for (const item of scope[1].split(" ")) requested.add(item);
  }
  assert.ok(requested.has("https://www.googleapis.com/auth/calendar.events"), "the scan found the calendar scope");
  const html = visible((await page("/privacy/google")).html);
  const shown = new Set([...html.matchAll(/<code[^>]*>([^<]+)<\/code>/g)].map((match) => match[1]));
  assert.deepEqual([...shown].sort(), [...requested].sort());
  for (const url of html.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g)) {
    assert.ok(requested.has(url[0]), `${url[0]} is on the page but not requested by any connect route`);
  }
});

test("the data-sources page states the robots.txt rule collection actually follows, in both states", async () => {
  const off = text((await page("/data-sources", { ROBOTS_TXT_ENFORCED: undefined, FIRSTSEEN_CONTACT_EMAIL: CONTACT })).html);
  assert.match(off, /Collection does not yet check robots\.txt before each request/);
  assert.doesNotMatch(off, /skips every address it disallows/);
  const on = text((await page("/data-sources", { ROBOTS_TXT_ENFORCED: "true", FIRSTSEEN_CONTACT_EMAIL: CONTACT })).html);
  assert.match(on, /collection reads that site's robots\.txt, once per site per run, and skips every address it disallows/);
  assert.match(on, /the whole site is skipped for that run/);
  assert.doesNotMatch(on, /does not yet check robots\.txt/);
});

test("the calendar sync panel no longer says the permission is limited to 1stSeen's own events", () => {
  const source = readFileSync(new URL("../components/google-calendar-sync.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /permission to manage only calendar events it creates/);
  assert.match(source, /view and edit events on all your calendars/);
});
