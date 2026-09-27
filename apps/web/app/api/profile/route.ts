import { z } from "zod";
import { hasSupabaseConfig } from "@/lib/config";
import { AVATARS, SCHOOL_MAX, readGraduationYear, readHandle, readSchool } from "@/lib/profile";
import { saveGraduationYear, saveProfile } from "@/lib/profile-data";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

/**
 * A person's own details.
 *
 * The owner is the Supabase session and nothing else: there is no user id in the body to send, so there is no
 * request that writes another person's row (apps/web/tests/profile-route.test.mjs). Every field is normalised by
 * lib/profile.ts before it is stored — the address a person pastes becomes the handle it contains, and anything
 * that is not a handle that service could issue is refused rather than kept as typed.
 */

const editSchema = z.object({
  avatar: z.enum(AVATARS).nullable().optional(),
  school: z.string().max(400).nullable().optional(),
  github: z.string().max(400).nullable().optional(),
  linkedin: z.string().max(400).nullable().optional(),
  graduation_year: z.union([z.number().int(), z.string(), z.null()]).optional(),
}).strict();

export async function PATCH(request: Request) {
  if (!hasSupabaseConfig() || !hasServiceRoleConfig()) {
    return Response.json({ error: "accounts_not_configured" }, { status: 503 });
  }
  const session = await currentSession();
  if (!session) return Response.json({ error: "not_signed_in" }, { status: 401 });

  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_profile_request" }, { status: 400 });
  const edit = parsed.data;

  // A field the form sent but could not read is the one thing worth saying back, so the person can correct it
  // rather than watch it disappear.
  const rejected: string[] = [];
  const handle = (service: "github" | "linkedin", value: string | null | undefined) => {
    if (value === undefined) return undefined;
    if (value === null || value.trim() === "") return null;
    const read = readHandle(service, value);
    if (read === null) rejected.push(service);
    return read;
  };

  const year = (() => {
    if (!("graduation_year" in edit)) return undefined;
    const sent = edit.graduation_year;
    if (sent === null || sent === "") return null;
    const read = readGraduationYear(sent);
    if (read === null) rejected.push("graduation_year");
    return read;
  })();

  const github = handle("github", edit.github);
  const linkedin = handle("linkedin", edit.linkedin);
  if (rejected.length > 0) return Response.json({ error: "unreadable_fields", fields: rejected }, { status: 400 });

  try {
    await saveProfile(session.userId, {
      ...("avatar" in edit ? { avatar: edit.avatar ?? null } : {}),
      ...("school" in edit ? { school: edit.school === null ? null : readSchool(edit.school ?? "") } : {}),
      ...(github === undefined ? {} : { githubHandle: github }),
      ...(linkedin === undefined ? {} : { linkedinHandle: linkedin }),
    });
    if (year !== undefined) await saveGraduationYear(session.userId, year);
  } catch {
    return Response.json({ error: "profile_update_failed" }, { status: 500 });
  }
  return Response.json({ status: "saved", school_max: SCHOOL_MAX });
}
