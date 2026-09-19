/**
 * The Just opened feed keeps any one company to two of every six consecutive items, newest first otherwise, and
 * places everything it can; what no ordering could place is counted per company.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { interleaveByCompany, keepsCompanyRule } from "../lib/just-opened.ts";

const company = (item) => item.company;

test("a batch from one company is spread out, and each company keeps its newest-first order", () => {
  // Newest first: Bosch posted six on the newest day, then three other companies.
  const items = [
    ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => ({ id, company: "bosch" })),
    { id: "s1", company: "stripe" }, { id: "s2", company: "stripe" },
    { id: "f1", company: "figma" }, { id: "r1", company: "robinhood" }, { id: "r2", company: "robinhood" },
  ];
  const { feed, overflow } = interleaveByCompany(items, company);
  assert.ok(keepsCompanyRule(feed, company));
  assert.deepEqual(feed.map((item) => item.id).slice(0, 6), ["b1", "b2", "s1", "s2", "f1", "r1"]);
  for (const name of ["bosch", "stripe", "robinhood"]) {
    const ids = feed.filter((item) => item.company === name).map((item) => item.id);
    assert.deepEqual(ids, [...ids].sort(), `${name} stays newest first`);
  }
  // Six Bosch openings and five others: some Bosch openings cannot be placed without crowding, and are counted.
  assert.equal(feed.length + overflow.reduce((sum, item) => sum + item.count, 0), items.length);
  assert.deepEqual(overflow.map((item) => item.company), ["bosch"]);
});

test("a feed with enough companies places every opening", () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ id: index, company: `c${index % 5}` }));
  const { feed, overflow } = interleaveByCompany(items, company);
  assert.equal(feed.length, 60);
  assert.deepEqual(overflow, []);
  assert.ok(keepsCompanyRule(feed, company));
});

test("the rule holds on random feeds, and nothing is lost", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 200; run += 1) {
    const companies = 1 + Math.floor(random() * 8);
    const items = Array.from({ length: Math.floor(random() * 80) }, (_, id) => ({ id, company: `c${Math.floor(random() ** 2 * companies)}` }));
    const { feed, overflow } = interleaveByCompany(items, company);
    assert.ok(keepsCompanyRule(feed, company), `run ${run}`);
    assert.equal(feed.length + overflow.reduce((sum, item) => sum + item.count, 0), items.length);
    // Nothing is left over while a third company could still be placed.
    assert.ok(new Set(overflow.map((item) => item.company)).size <= 2, `run ${run}`);
  }
});

test("the rule is checked over every window of six", () => {
  assert.equal(keepsCompanyRule(["a", "a", "b", "c", "d", "e", "a"].map((c) => ({ company: c })), company), true);
  assert.equal(keepsCompanyRule(["a", "a", "b", "c", "d", "a"].map((c) => ({ company: c })), company), false);
});
