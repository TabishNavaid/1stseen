import assert from "node:assert/strict";
import test from "node:test";

import { contentSecurityPolicy, originOf } from "../cloudflare/security-headers.ts";

async function render(pathname, { origin = "http://localhost", headers = {}, env = {} } = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  delete process.env.FIRSTSEEN_DEMO_MODE;
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    return await worker.fetch(
      new Request(`${origin}${pathname}`, { headers: { accept: "text/html", ...headers } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const directive = (policy, name) =>
  policy.split(";").map((part) => part.trim()).find((part) => part === name || part.startsWith(`${name} `));

test("every rendered response carries the security headers, error pages included", async () => {
  for (const pathname of ["/", "/signin", "/roles/does-not-exist"]) {
    const response = await render(pathname);
    assert.ok(response.headers.get("content-security-policy"), `${pathname} has a CSP`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const hsts = /^max-age=(\d+); includeSubDomains$/.exec(response.headers.get("strict-transport-security") ?? "");
    assert.ok(hsts && Number(hsts[1]) >= 31_536_000, `${pathname} has a year-long HSTS policy`);
  }
});

test("script-src admits only same-origin files and this request's nonce, and every script carries it", async () => {
  const response = await render("/signin");
  const policy = response.headers.get("content-security-policy");
  const scriptSrc = directive(policy, "script-src");
  const nonce = /'nonce-([A-Za-z0-9_-]{16,})'/.exec(scriptSrc)?.[1];
  assert.ok(nonce, "script-src carries a nonce");
  assert.equal(scriptSrc, `script-src 'self' 'nonce-${nonce}'`);
  assert.equal(directive(policy, "default-src"), "default-src 'self'");
  assert.equal(directive(policy, "object-src"), "object-src 'none'");
  assert.equal(directive(policy, "base-uri"), "base-uri 'none'");
  assert.equal(directive(policy, "frame-ancestors"), "frame-ancestors 'none'");
  assert.doesNotMatch(policy, /\*|unsafe-eval/);

  // A policy the renderer did not honour would block the page; one it ignored would be decorative.
  const scripts = [...(await response.text()).matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const attributes of scripts) assert.ok(attributes.includes(`nonce="${nonce}"`), `script without nonce: ${attributes}`);
});

test("a caller cannot choose the nonce, and nonces are never reused", async () => {
  const forged = await render("/signin", {
    headers: { "content-security-policy": "script-src 'nonce-attackerchosen0123456789'" },
  });
  assert.doesNotMatch(forged.headers.get("content-security-policy"), /attackerchosen/);
  assert.doesNotMatch(await forged.text(), /attackerchosen/);

  const first = (await render("/")).headers.get("content-security-policy");
  const second = (await render("/")).headers.get("content-security-policy");
  assert.notEqual(first, second);
});

test("connect-src never publishes the agent service, and lists only bare origins", async () => {
  // The browser never calls the agent API; the Worker proxies it with the bearer token.
  const response = await render("/", {
    env: { FIRSTSEEN_AGENT_API_URL: "https://firstseen-agent-abc123-uw.a.run.app" },
  });
  const connect = directive(response.headers.get("content-security-policy"), "connect-src");
  assert.match(connect, /^connect-src 'self'/);
  assert.doesNotMatch(connect, /run\.app|firstseen-agent/);
  // Every Supabase Auth call runs on the server, so the browser needs no third-party origin at all.
  assert.equal(connect, "connect-src 'self'");
  for (const source of connect.split(" ").slice(2)) {
    assert.match(source, /^https?:\/\/[^/?#\s]+$/, `connect-src entry is a bare origin: ${source}`);
  }
});

test("insecure requests are upgraded only when the page itself is served over HTTPS", async () => {
  const secure = await render("/", { origin: "https://firstseen.test" });
  assert.ok(directive(secure.headers.get("content-security-policy"), "upgrade-insecure-requests"));
  const local = await render("/");
  assert.equal(directive(local.headers.get("content-security-policy"), "upgrade-insecure-requests"), undefined);
});

test("only absolute http(s) URLs contribute an origin", () => {
  assert.equal(originOf("https://abc.supabase.co/rest/v1?x=1"), "https://abc.supabase.co");
  assert.equal(originOf("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  for (const value of [undefined, "", "not a url", "javascript:alert(1)", "data:text/html,x", "ftp://example.test"]) {
    assert.equal(originOf(value), null);
  }
  const policy = contentSecurityPolicy({ nonce: "n0nce", connectOrigins: [null, "https://a.test", "https://a.test"], upgradeInsecureRequests: false });
  assert.equal(directive(policy, "connect-src"), "connect-src 'self' https://a.test");
});
