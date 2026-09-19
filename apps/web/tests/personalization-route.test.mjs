import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/personalization/route.ts", import.meta.url),
  "utf8",
);

test("personalization writes derive ownership from the authenticated Supabase user", () => {
  assert.match(route, /supabase\.auth\.getUser\(\)/);
  assert.match(route, /user_id: userId/);
  assert.doesNotMatch(route, /user_id:\s*parsed\.data/);
});

test("personalization mutations scope updates and deletes to the owner", () => {
  assert.match(route, /\.delete\(\)[\s\S]*?\.eq\("user_id", userId\)/);
  assert.match(route, /\.update\([\s\S]*?\.eq\("user_id", userId\)/);
  assert.match(route, /status: 401/);
});
