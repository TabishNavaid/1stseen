import assert from "node:assert/strict";
import test from "node:test";

import { httpUrlSchema } from "../src/domain.ts";

test("external evidence links accept only HTTP(S) URLs", () => {
  assert.equal(httpUrlSchema.parse("https://careers.example/jobs/123"), "https://careers.example/jobs/123");
  assert.equal(httpUrlSchema.safeParse("javascript:alert(1)").success, false);
  assert.equal(httpUrlSchema.safeParse("file:///etc/passwd").success, false);
});
