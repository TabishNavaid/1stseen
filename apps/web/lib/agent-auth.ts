import "server-only";

import { currentSession } from "@/lib/session";

export type AgentCaller = { userId: string };

/**
 * Identity for the worker-backed routes (agent, replay).
 *
 * Only a Supabase session counts. Identity asserted by request headers (for example the
 * OpenAI Apps `oai-authenticated-user-*` headers) is not accepted: on a public Worker any
 * client can send them, and nothing here can verify who set them. A caller without a
 * session is unauthenticated, and the routes stay default-closed unless the explicit
 * local-development flag is set.
 */
export async function agentCaller(): Promise<AgentCaller | null> {
  const session = await currentSession();
  return session ? { userId: session.userId } : null;
}

export function unauthenticatedDevAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production"
    && process.env.ALLOW_UNAUTHENTICATED_AGENT_DEV === "true"
  );
}
