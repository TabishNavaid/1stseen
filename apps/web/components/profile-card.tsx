"use client";

import { useState } from "react";
import { Doodle, type DoodleName } from "@/components/doodle";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { AVATARS, GRADUATION_YEARS, SCHOOL_MAX, handleUrl, isAvatar } from "@/lib/profile";
import { cn } from "@/lib/utils";

export type ProfileFields = {
  displayName: string | null;
  avatar: string | null;
  school: string | null;
  githubHandle: string | null;
  linkedinHandle: string | null;
  graduationYear: number | null;
};

// lib/profile.ts names the characters without importing React; this is where those names have to be drawings.
AVATARS satisfies readonly DoodleName[];

const FIELD_NAMES: Record<string, string> = {
  github: "That is not a GitHub account name.",
  linkedin: "That is not a LinkedIn profile name.",
  graduation_year: `A year between ${GRADUATION_YEARS.first} and ${GRADUATION_YEARS.last}.`,
};

/**
 * Who you are, on your own settings page: the character you picked, where you study, and the two places early-career
 * hiring looks. It is your own copy and nobody else's — 1stSeen has no public profile to put it on.
 *
 * An address pasted into either link field is read for the handle inside it, so github.com/name and name both work,
 * and the address is built from what is stored rather than stored as typed (lib/profile.ts). A field the server
 * could not read comes back named, so it can be corrected instead of silently dropped.
 */
export function ProfileCard({ profile, email }: { profile: ProfileFields; email: string | null }) {
  const [saved, setSaved] = useState(profile);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const save = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    setBusy(true);
    setErrors([]);
    setFailed(false);
    const avatar = text("avatar");
    const body = {
      avatar: isAvatar(avatar) ? avatar : null,
      school: text("school") || null,
      github: text("github") || null,
      linkedin: text("linkedin") || null,
      graduation_year: text("graduation_year") || null,
    };
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        setSaved({
          ...saved,
          avatar: body.avatar,
          school: body.school,
          // What the server stored is the handle inside what was typed; showing the address back is the page's job.
          githubHandle: body.github ? body.github.replace(/^.*github\.com\//i, "").replace(/^@/, "") : null,
          linkedinHandle: body.linkedin ? body.linkedin.replace(/^.*\/in\//i, "").replace(/[/?#].*$/, "") : null,
          graduationYear: body.graduation_year ? Number(body.graduation_year) : null,
        });
        setEditing(false);
        return;
      }
      const problem = await response.json().catch(() => null);
      if (Array.isArray(problem?.fields)) setErrors(problem.fields);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // Named in words rather than by a brand mark: the site draws its own art, and two logos would be the only two
  // marks on it that are somebody else's.
  const links = [
    saved.githubHandle ? { key: "github" as const, service: "GitHub", handle: saved.githubHandle, href: handleUrl("github", saved.githubHandle) } : null,
    saved.linkedinHandle ? { key: "linkedin" as const, service: "LinkedIn", handle: saved.linkedinHandle, href: handleUrl("linkedin", saved.linkedinHandle) } : null,
  ].filter((item) => item !== null);

  const said = [saved.school, saved.graduationYear ? `Class of ${saved.graduationYear}` : null].filter(Boolean).join(" · ");

  return (
    <section aria-labelledby="profile-title" className="border-b border-line pb-8">
      <div className="flex flex-wrap items-start gap-5">
        <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-full bg-accent-soft">
          {isAvatar(saved.avatar)
            ? <Doodle name={saved.avatar} size="fit" className="size-16" />
            : <span aria-hidden="true" className="heading-display text-3xl text-accent-ink">{(saved.displayName ?? email ?? "?").slice(0, 1).toUpperCase()}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <h1 id="profile-title" className="heading-display text-3xl">{saved.displayName ?? "Your profile"}</h1>
          <p className="mt-1 min-w-0 truncate text-sm text-ink-muted">{email ?? "Signed in"}</p>
          {said && <p className="mt-2 text-sm text-ink">{said}</p>}
          {links.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {links.map((link) => (
                <li key={link.key}>
                  <a href={link.href} target="_blank" rel="me noopener noreferrer" className="link-accent focus-ring inline-flex items-center gap-1.5 text-sm">
                    <span className="text-ink-subtle">{link.service}</span>{link.handle}
                    <Icon name="arrow-up-right" size={13} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!editing && (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setEditing(true)}>
              {said || links.length > 0 ? "Edit your details" : "Add your details"}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          className="mt-6 grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save(event.currentTarget);
          }}
        >
          <fieldset className="m-0 border-0 p-0">
            <legend className="label-caps p-0 text-ink-subtle">Your character</legend>
            <p className="mt-1 text-caption text-ink-subtle">One of the drawings this site is made of. There is nothing to upload.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {AVATARS.map((name) => (
                <label
                  key={name}
                  className={cn(
                    "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus grid size-16 cursor-pointer place-items-center rounded-full border transition-colors",
                    saved.avatar === name ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-hover",
                  )}
                >
                  <input
                    type="radio"
                    name="avatar"
                    value={name}
                    defaultChecked={saved.avatar === name}
                    onChange={() => setSaved((current) => ({ ...current, avatar: name }))}
                    className="sr-only"
                  />
                  <Doodle name={name} size="fit" className="size-11" />
                  <span className="sr-only">{name}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="profile-school" label="Where you study">
              {(control) => <Input {...control} name="school" defaultValue={saved.school ?? ""} maxLength={SCHOOL_MAX} placeholder="University of somewhere" />}
            </Field>
            <Field id="profile-graduation" label="Graduating" error={errors.includes("graduation_year") ? FIELD_NAMES.graduation_year : undefined}>
              {(control) => (
                <Input
                  {...control}
                  name="graduation_year"
                  inputMode="numeric"
                  defaultValue={saved.graduationYear ?? ""}
                  placeholder="2028"
                />
              )}
            </Field>
            <Field id="profile-github" label="GitHub" description="Your account name, or the address of your profile." error={errors.includes("github") ? FIELD_NAMES.github : undefined}>
              {(control) => <Input {...control} name="github" defaultValue={saved.githubHandle ?? ""} placeholder="octocat" />}
            </Field>
            <Field id="profile-linkedin" label="LinkedIn" description="The name in your profile's address." error={errors.includes("linkedin") ? FIELD_NAMES.linkedin : undefined}>
              {(control) => <Input {...control} name="linkedin" defaultValue={saved.linkedinHandle ?? ""} placeholder="your-name" />}
            </Field>
          </div>

          {failed && <p role="alert" className="text-caption font-semibold text-danger-ink">That could not be saved. Nothing was changed.</p>}

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setErrors([]); setFailed(false); }}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}
