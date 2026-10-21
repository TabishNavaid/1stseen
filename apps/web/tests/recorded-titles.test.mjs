/**
 * A render reads each role's recorded titles once, however many of its parts name that role.
 *
 * The landing page read `role_aliases` twice: once inside `loadJustOpened` for the openings it shows, once for the
 * preview role and the opening-soon rows. Every role the two sets shared was read twice, and a role with no alias was
 * asked for again because nothing recorded that the answer was "none".
 *
 * Proven to fail when the prevention is removed: replacing `memoizedTitles` with the bare loader makes the second
 * call ask for every id again, and "only the role not already read" fails with all three ids.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { memoizedTitles } from "../lib/recorded-titles.ts";

/** A loader that records every id list it was asked for, answering from a fixed alias table. */
function stubLoader(aliases) {
  const asked = [];
  return {
    asked,
    load: async (ids) => {
      asked.push([...ids]);
      return new Map(
        ids
          .filter((id) => aliases[id])
          .map((id) => [id, aliases[id].map((title) => ({ title, lastSeenAt: "2026-09-01T00:00:00Z" }))]),
      );
    },
  };
}

test("a role is asked for once across a render, and one with no alias is not asked again", async () => {
  const loader = stubLoader({ "role-a": ["Software Engineer Intern"], "role-b": ["Hardware Intern"] });
  const read = memoizedTitles(loader.load);

  const first = await read(["role-a", "role-b", "role-none"]);
  assert.equal(first.get("role-a")?.[0].title, "Software Engineer Intern");
  assert.deepEqual(first.get("role-none"), [], "a role with no alias answers as having none");
  assert.deepEqual(loader.asked, [["role-a", "role-b", "role-none"]]);

  // The render's second part names two roles already read and one new: only the new one reaches the database.
  const second = await read(["role-b", "role-none", "role-c"]);
  assert.deepEqual(loader.asked[1], ["role-c"], "only the role not already read");
  assert.equal(second.get("role-b")?.[0].title, "Hardware Intern", "and the remembered answer still comes back");
  assert.deepEqual(second.get("role-c"), []);

  // Asking again for nothing new costs no request at all.
  await read(["role-a", "role-b"]);
  assert.equal(loader.asked.length, 2);
});

test("a repeated id in one call is asked for once", async () => {
  const loader = stubLoader({ "role-a": ["Intern"] });
  await memoizedTitles(loader.load)(["role-a", "role-a", "role-a"]);
  assert.deepEqual(loader.asked, [["role-a"]]);
});
