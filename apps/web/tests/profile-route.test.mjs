/**
 * A person's own details: what the form is allowed to say, and whose row it can possibly write.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AVATARS, GRADUATION_YEARS, SCHOOL_MAX, handleUrl, isAvatar, readGraduationYear, readHandle, readSchool } from "../lib/profile.ts";

const route = readFileSync(new URL("../app/api/profile/route.ts", import.meta.url), "utf8");
const data = readFileSync(new URL("../lib/profile-data.ts", import.meta.url), "utf8");

test("the owner is the session, and there is no user id in the request to send", () => {
  assert.match(route, /const session = await currentSession\(\)/);
  assert.match(route, /session\.userId/);
  assert.match(route, /status: 401/);
  // Every write is keyed by the id the session gave, and the body's schema has no place to put another one.
  assert.match(data, /\.update\(columns\)\s*\.eq\("id", userId\)/);
  assert.match(data, /\.upsert\(\{ user_id: userId,/);
  assert.doesNotMatch(route, /user_id|userId\s*[:=]\s*(?:parsed|edit|body)/);
  assert.match(route, /\}\)\.strict\(\)/, "an unknown field is refused, not stored");
});

test("a link is stored as the handle inside it, however it was typed", () => {
  for (const typed of ["octocat", "@octocat", "github.com/octocat", "https://github.com/octocat", "https://www.github.com/octocat/", "https://github.com/octocat?tab=repositories"]) {
    assert.equal(readHandle("github", typed), "octocat", typed);
  }
  for (const typed of ["your-name", "linkedin.com/in/your-name", "https://www.linkedin.com/in/your-name/", "https://uk.linkedin.com/in/your-name"]) {
    assert.equal(readHandle("linkedin", typed), "your-name", typed);
  }
  assert.equal(handleUrl("github", "octocat"), "https://github.com/octocat");
  assert.equal(handleUrl("linkedin", "your-name"), "https://www.linkedin.com/in/your-name");
});

test("anything that is not a handle that service could issue is refused, not kept as typed", () => {
  for (const typed of ["", "   ", "-leading", "trailing-", "two--hyphens", "has space", "a".repeat(40), "javascript:alert(1)", "https://example.com/octocat", "../octocat"]) {
    assert.equal(readHandle("github", typed), null, typed);
  }
  for (const typed of ["ab", "-leading", "has space", "https://example.com/in/name"]) {
    assert.equal(readHandle("linkedin", typed), null, typed);
  }
  // The only addresses the product ever writes are the two it builds itself, so nothing stored can become a link
  // somewhere else.
  assert.equal(handleUrl("github", readHandle("github", "https://evil.example/octocat") ?? "x"), "https://github.com/x");
});

test("the rest of the details are bounded, and a year is a year", () => {
  assert.equal(readSchool("  University   of  Somewhere  "), "University of Somewhere");
  assert.equal(readSchool("   "), null);
  assert.equal(readSchool("a".repeat(400))?.length, SCHOOL_MAX);
  assert.equal(readGraduationYear("2028"), 2028);
  assert.equal(readGraduationYear(2028), 2028);
  assert.equal(readGraduationYear(GRADUATION_YEARS.first - 1), null);
  assert.equal(readGraduationYear(GRADUATION_YEARS.last + 1), null);
  assert.equal(readGraduationYear("soon"), null);
});

test("the characters offered are drawings this product has, and an unknown one draws nothing", () => {
  const doodles = readFileSync(new URL("../components/doodle.tsx", import.meta.url), "utf8");
  for (const name of AVATARS) assert.match(doodles, new RegExp(`\\b${name}:`), `${name} is a drawing`);
  assert.equal(isAvatar("meditating"), true);
  assert.equal(isAvatar("a-name-from-a-later-version"), false);
  // Which characters are offered is a product decision, so the column checks the shape and the app checks the set.
  const migration = readFileSync(new URL("../../../supabase/migrations/202608140055_profile_details.sql", import.meta.url), "utf8");
  assert.match(migration, /avatar text\s*\n\s*check \(avatar is null or avatar ~ '\^\[a-z\]\[a-z-\]\{0,30\}\$'\)/);
  assert.doesNotMatch(migration, /^\s*grant\s/im, "authenticated gets no write on profiles; the route is the only writer");
});

test("the new columns leave with the account, and the export names them", () => {
  const exported = readFileSync(new URL("../lib/account/data.ts", import.meta.url), "utf8");
  for (const column of ["avatar", "school", "github_handle", "linkedin_handle"]) {
    assert.match(exported, new RegExp(`profiles:[^\\n]*${column}`), `${column} is in the account export`);
  }
});
