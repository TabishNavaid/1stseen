import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/api/forecast-replay/route.ts", import.meta.url), "utf8");

test("forecast replay proxy validates the temporal request and keeps the worker token server-side", () => {
  assert.match(source, /role_id:\s*z\.string\(\)\.uuid\(\)/);
  assert.match(source, /forecast_cutoff/);
  assert.match(source, /\/v1\/forecast-replay/);
  assert.match(source, /authorization:\s*`Bearer \$\{token\}`/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_.*TOKEN|service_role/i);
});
