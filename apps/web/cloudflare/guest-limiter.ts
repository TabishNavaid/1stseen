/**
 * Exact guest question limits, counted in a Durable Object.
 *
 * Workers Rate Limiting bindings count per Cloudflare location and settle late: measured on the production edge, a
 * binding set to 3 a minute allowed 13 calls from one address before its first refusal and 20 of 35 over the next 39
 * seconds. A limit that small needs one strongly consistent counter, so each key is one Durable Object: one per client
 * address, and one shared by every guest. An object handles its requests one at a time and keeps its count in its own
 * storage, so the Nth question in a minute is refused wherever it arrives from.
 *
 * The object keeps a sliding window: the times of the questions it allowed in the last `period`. A refused question is
 * not recorded, so a guest who keeps asking is let in again as soon as the oldest allowed question leaves the window.
 * The object is written against the plain Durable Object interface (a class with `fetch`), with no `cloudflare:workers`
 * import, so the built Worker still loads in the Node test harness, which never constructs it.
 */
import type { GuestAgentLimits } from "./guest-agent";

type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type DurableObjectStateLike = {
  storage: Storage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

type DurableObjectStubLike = { fetch(input: string, init?: RequestInit): Promise<Response> };

export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

export type WindowDecision = { allowed: boolean; hits: number[]; retryAfterSeconds: number };

/** Whether one more question fits in the window, and the window after it. Pure, so the rule is tested directly. */
export function takeFromWindow(hits: readonly number[], now: number, limit: number, periodMs: number): WindowDecision {
  const recent = hits.filter((at) => at > now - periodMs).sort((a, b) => a - b);
  if (recent.length >= limit) {
    return { allowed: false, hits: recent, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + periodMs - now) / 1000)) };
  }
  return { allowed: true, hits: [...recent, now], retryAfterSeconds: 0 };
}

const HITS_KEY = "hits";

export class GuestQuestionLimiter {
  private hits: number[] = [];
  private readonly loaded: Promise<void>;
  private readonly state: DurableObjectStateLike;
  private readonly clock: () => number;

  // Plain fields rather than parameter properties: the Node test harness strips types and cannot run those.
  constructor(state: DurableObjectStateLike, _env?: unknown, clock: () => number = Date.now) {
    this.state = state;
    this.clock = clock;
    this.loaded = state.blockConcurrencyWhile(async () => {
      this.hits = (await state.storage.get<number[]>(HITS_KEY)) ?? [];
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit"));
    const periodMs = Number(url.searchParams.get("period_ms"));
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(periodMs) || periodMs < 1000) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    // Read, decide, and assign with no await between them, so two questions in flight cannot both take the last place.
    const decision = takeFromWindow(this.hits, this.clock(), limit, periodMs);
    this.hits = decision.hits;
    await this.state.storage.put(HITS_KEY, this.hits);
    return Response.json({ allowed: decision.allowed, retry_after_seconds: decision.retryAfterSeconds });
  }
}

/** One limit, as the `limit({ key })` shape guestAgentAllowance takes, backed by one Durable Object per key. */
export function durableLimit(namespace: DurableObjectNamespaceLike, limit: number, periodSeconds: number) {
  return {
    async limit({ key }: { key: string }): Promise<{ success: boolean; retryAfterSeconds?: number }> {
      const stub = namespace.get(namespace.idFromName(key));
      const response = await stub.fetch(`https://guest-question-limiter/take?limit=${limit}&period_ms=${periodSeconds * 1000}`, {
        method: "POST",
      });
      // A limiter that cannot answer refuses: guest questions fail closed, never open.
      if (!response.ok) return { success: false };
      const body = (await response.json()) as { allowed?: unknown; retry_after_seconds?: unknown };
      return {
        success: body.allowed === true,
        retryAfterSeconds: typeof body.retry_after_seconds === "number" ? body.retry_after_seconds : undefined,
      };
    },
  };
}

/** The two per-address auth limits (auth-limits.ts), counted by the same Durable Object namespace. */
export function durableAuthLimits(
  namespace: DurableObjectNamespaceLike,
  attempts: number,
  verifications: number,
  periodSeconds: number,
) {
  return {
    attempt: durableLimit(namespace, attempts, periodSeconds),
    verification: durableLimit(namespace, verifications, periodSeconds),
  };
}

/** The two guest limits, counted by the GUEST_QUESTION_LIMITER Durable Object namespace. */
export function durableGuestLimits(
  namespace: DurableObjectNamespaceLike,
  perAddress: number,
  overall: number,
  periodSeconds: number,
): Required<GuestAgentLimits> {
  return {
    GUEST_AGENT_ADDRESS_LIMIT: durableLimit(namespace, perAddress, periodSeconds),
    GUEST_AGENT_OVERALL_LIMIT: durableLimit(namespace, overall, periodSeconds),
  };
}
