#!/usr/bin/env node
/**
 * Fetch each company's favicon once, store it with the product, and write the manifest the page reads.
 *
 * A company card shows the company's own mark rather than the first letter of its name, and a mark 1stSeen serves
 * itself rather than one a third party can watch being loaded: the Content-Security-Policy is `img-src 'self'`, and
 * a card that reached out to a company's server on every render would tell that company who is looking at it.
 *
 * What it takes is the favicon a site publishes for exactly this purpose, from the site's own root, and nothing
 * else: no brand page, no logo directory, no asset pipeline. A company with no usable favicon keeps its letter tile,
 * which is a perfectly good mark. Nothing here is credited, because a favicon is not a work anyone signs.
 *
 * Usage: node scripts/fetch-company-logos.mjs [--limit 400] [--force]
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Output is committed.
 */

import { loadDotEnv, requireEnv, restClient } from "./lib/db.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGOS = resolve(ROOT, "apps/web/public/logos");
const MANIFEST = resolve(ROOT, "apps/web/lib/brand/company-logos.ts");

const argv = process.argv.slice(2);
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const LIMIT = Number(flag("--limit") ?? 500);
const FORCE = argv.includes("--force");
/** A favicon is small. Anything much larger is a page, a redirect chain, or something not worth serving. */
const MAX_BYTES = 120_000;
const TYPES = new Map([["image/png", "png"], ["image/x-icon", "ico"], ["image/vnd.microsoft.icon", "ico"], ["image/svg+xml", "svg"], ["image/webp", "webp"], ["image/jpeg", "jpg"], ["image/gif", "gif"]]);

/** The key a company is looked up by: its name, folded the way `companyKey` in the web app folds it. */
export function companyKey(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function favicon(domain) {
  for (const url of [`https://${domain}/favicon.ico`, `https://www.${domain}/favicon.ico`]) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "1stSeen/1.0 (+https://1stseen.win)" } });
      if (!response.ok) continue;
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const extension = TYPES.get(type);
      if (!extension) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) continue;
      // An SVG is markup, and markup a third party wrote is not served from this origin.
      if (extension === "svg") continue;
      return { bytes, extension };
    } catch {
      // Unreachable, too slow, or not serving one: the letter tile is the answer.
    }
  }
  return null;
}

requireEnv("SUPABASE_URL");
const reader = await restClient();
const { data, error } = await reader.from("companies").select("id,name,domain").order("name").limit(LIMIT);
if (error) throw new Error(`companies read failed: ${error.message}`);

mkdirSync(LOGOS, { recursive: true });
if (FORCE) for (const file of readdirSync(LOGOS)) rmSync(resolve(LOGOS, file));
const have = new Set(readdirSync(LOGOS));
const manifest = {};
let fetched = 0;
let kept = 0;

for (const company of data ?? []) {
  const key = companyKey(company.name);
  if (!key || !company.domain) continue;
  const existing = [...have].find((file) => file.startsWith(`${key}.`));
  if (existing && !FORCE) { manifest[key] = existing; kept += 1; continue; }
  const found = await favicon(String(company.domain).replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!found) continue;
  const name = `${key}.${found.extension}`;
  // One file per company: a re-fetch that lands a different type must not leave the old one behind.
  for (const stale of [...have].filter((file) => file.startsWith(`${key}.`) && file !== name)) {
    rmSync(resolve(LOGOS, stale), { force: true });
    have.delete(stale);
  }
  writeFileSync(resolve(LOGOS, name), found.bytes);
  have.add(name);
  manifest[name.slice(0, name.lastIndexOf("."))] = name;
  fetched += 1;
}

const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(MANIFEST, `// Written by scripts/fetch-company-logos.mjs. Run it again to pick up companies added since.

/**
 * The companies whose own mark 1stSeen serves, by the folded form of their name. A company that is not here keeps its
 * letter tile; both are drawn by components/brand/company-mark.tsx.
 */
export const COMPANY_LOGOS: Record<string, string> = ${JSON.stringify(ordered, null, 2)};
`);

const digest = createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 8);
process.stdout.write(`${Object.keys(ordered).length} logos (${fetched} fetched, ${kept} already here), manifest ${digest}\n`);
