import vinext from "vinext";
import { defineConfig } from "vite";
import { GUEST_LIMIT_PERIOD_SECONDS, GUEST_QUESTIONS_OVERALL, GUEST_QUESTIONS_PER_ADDRESS } from "./cloudflare/guest-agent";

const localBindingConfig = {
  main: "./cloudflare/index.ts",
  compatibility_flags: ["nodejs_compat"],
  // Guest questions to the agent (cloudflare/guest-agent.ts). A namespace_id is an integer shared across this Cloudflare
  // account, so these two must not collide with another Worker's.
  ratelimits: [
    { name: "GUEST_AGENT_ADDRESS_LIMIT", namespace_id: "18001", simple: { limit: GUEST_QUESTIONS_PER_ADDRESS, period: GUEST_LIMIT_PERIOD_SECONDS } },
    { name: "GUEST_AGENT_OVERALL_LIMIT", namespace_id: "18002", simple: { limit: GUEST_QUESTIONS_OVERALL, period: GUEST_LIMIT_PERIOD_SECONDS } },
  ],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    envDir: "../..",
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
