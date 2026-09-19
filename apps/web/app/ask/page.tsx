import type { Metadata } from "next";
import { AskPanel } from "@/components/agent/ask-panel";
import { SiteHeader } from "@/components/site-header";
import { GUEST_QUESTIONS_PER_ADDRESS } from "@/cloudflare/guest-agent";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Ask",
  description: "Ask about early-career programs: when they open, what just opened, and how sure a date is.",
};

// The session decides the guest note; nothing here is cached per visitor.
export const dynamic = "force-dynamic";

/** Ask 1stSeen: a question to the RecruitingAgent, answered from the site's own openings and forecasts. */
export default async function AskPage() {
  const session = await currentSession();
  return (
    <>
      <SiteHeader active="ask" contentId="ask-content" />
      <main id="ask-content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-6 md:py-12">
        <p className="label-caps text-accent-ink">Ask 1stSeen</p>
        <h1 className="heading-display mt-2 text-3xl leading-tight sm:text-4xl">Ask about any program</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-muted">
          Answers come from the openings and forecasts on this site, and every step taken to reach one is listed with it.
        </p>
        <div className="mt-8"><AskPanel signedIn={session !== null} guestLimit={GUEST_QUESTIONS_PER_ADDRESS} /></div>
      </main>
    </>
  );
}
