/**
 * A link to a program inside a list does not prefetch.
 *
 * `next/link` prefetches by default, and an RSC prefetch of a role page is a full uncached server render: the guest
 * edge cache refuses anything carrying `_rsc` (`cloudflare/guest-cache.ts`, because an RSC payload is not a
 * document), so none of that work is ever reused by another visitor. A list renders one of these links per row.
 *
 * Measured on 1stseen.win on 2026-10-20, one visit to /roles: ten prefetches, 13.5 s of server work, the slowest
 * 3.4 s, median 944 ms, on top of a 3.8 s document — and 9.8 s for that document on a cold Worker. The same page
 * served from the edge cache answers in 77 ms. So the prefetching cost two orders of magnitude more than the page it
 * was trying to make instant, for the one row a reader actually clicks.
 *
 * This is a source check, not a behaviour check, and it says so: prefetching is client-side framework behaviour and
 * leaves no mark in the markup, so nothing short of a browser can observe it. What it does prevent is the regression
 * coming back by omission — a new list of programs that forgets the prop fails here. The counterpart check that this
 * is not decoration: delete `prefetch={false}` from any row below and this test goes red, which is how it was written.
 *
 * A single deliberate link still prefetches. The drawer's "Open the full program page" is one link behind an opened
 * drawer, which is as strong a click signal as exists, so it is exempt by not being in a list.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const WEB = new URL("..", import.meta.url).pathname;

/** Components that render one program link per row, and so must not prefetch any of them. */
const LISTS = [
  "components/forecast-row.tsx",
  "components/insufficient-role-row.tsx",
  "components/recruiting-timeline.tsx",
  "components/forecast-change.tsx",
  "components/recruiting-calendar.tsx",
];

/** Every `<Link ... href={`/roles/${...}`} ...>` opening tag in a source file. */
function roleLinks(source) {
  return [...source.matchAll(/<Link\b[^>]*?href=\{`\/roles\/\$\{[^}]*\}`\}[^>]*?>/gs)].map((match) => match[0]);
}

test("a program link inside a list does not prefetch", () => {
  for (const file of LISTS) {
    const source = readFileSync(`${WEB}${file}`, "utf8");
    const links = roleLinks(source);
    assert.ok(links.length > 0, `${file}: found no program link, so this check is watching nothing`);
    for (const link of links) {
      assert.ok(
        /\bprefetch=\{false\}/.test(link),
        `${file}: a program link in a list prefetches. An RSC prefetch of a role page is a full uncached server `
          + `render and a list fires one per row: ${link.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
  }
});

test("the matcher finds a prefetching link, so the check cannot pass by finding nothing", () => {
  // The same shapes the components use, one with the prop and one without.
  const allowed = "<Link href={`/roles/${role.id}`} prefetch={false} className=\"x\">";
  const refused = "<Link href={`/roles/${item.roleId}`} className=\"x\">";
  assert.equal(roleLinks(allowed).length, 1);
  assert.equal(roleLinks(refused).length, 1);
  assert.ok(/\bprefetch=\{false\}/.test(roleLinks(allowed)[0]));
  assert.ok(!/\bprefetch=\{false\}/.test(roleLinks(refused)[0]), "the matcher cannot tell the two apart");
});

test("a single deliberate link is not held to the list rule", () => {
  // The drawer's one link is the exemption, and it is an exemption by shape rather than by name: it is not in LISTS.
  const drawer = readFileSync(`${WEB}components/evidence-drawer.tsx`, "utf8");
  assert.ok(roleLinks(drawer).length > 0, "the drawer no longer links a program, so this exemption is stale");
  assert.ok(!LISTS.includes("components/evidence-drawer.tsx"));
});
