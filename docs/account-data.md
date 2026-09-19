# Account data: export and deletion

A signed-in user can download everything their account holds and can delete the account. Both are on `/settings`,
under "Your data". This page is the contract: the privacy policy describes exactly this behaviour, and a change here
changes what the policy promises.

| | Where |
| --- | --- |
| Export route | `apps/web/app/api/account/export/route.ts` (`GET /api/account/export`) |
| Deletion route | `apps/web/app/api/auth/delete-account/route.ts` (`POST /api/auth/delete-account`) |
| Deletion steps and the partial-failure rule | `apps/web/lib/account/deletion.ts` |
| What is exported | `apps/web/lib/account/data.ts` |
| Phrase, messages, credential check | `apps/web/lib/account/policy.ts` |
| Google revocation, shared with both disconnects | `apps/web/lib/google-revocation.ts` |
| Database side | migration `202608140037_account_deletion.sql` |
| Tests | `tests/account-policy.test.mjs`, `tests/account-routes.test.mjs`, `tests/integration/account-deletion.test.mjs` |

## Who can do it

Only the signed-in user, for their own account. The account is the Supabase session's user (`supabase.auth.getUser()`),
never a value in the request: the export takes no parameters, and the deletion body is a closed schema, so a `user_id`
in it is refused with 400 rather than ignored. Both routes refuse a cross-site request the way the other auth routes do
(`sameOrigin` in `lib/auth/route-helpers.ts`), so another site cannot make a visitor's browser download the file or
delete the account. User-owned rows are read and deleted with the service role and an explicit filter on the session's
id.

The uniform-response floors in `lib/auth/policy.ts` protect routes that take an email address and could reveal whether
it has an account. Neither route takes an address or acts on anyone but the caller, so neither has a floor. The deletion
route answers only fixed codes and never passes on a message from Google or Supabase.

## Download your data

"Download your data" saves one JSON file, `1stseen-account-YYYY-MM-DD.json` (`Content-Disposition: attachment`,
`Cache-Control: no-store`). It holds:

- **`account`**: the account id, email, when it was created, when the email was confirmed, and the last sign-in.
- **`tables`**, one key per database table, each a list of rows:
  - `profiles`: display name and time zone.
  - `recruiting_preferences`: the first-run answers (disciplines, graduation year, season, places) and preferences,
    with when the first run was finished or skipped.
  - `watchlist_items` and the legacy read-only `watchlists`: every follow.
  - `priority_companies`.
  - `readiness_milestones`: every preparation date with its policy version, rationale, and adjustments.
  - `calendar_event_syncs`: every event synced to Google Calendar, with its Google event id and status.
  - `email_digest_deliveries` and `email_digest_items`: every digest, including the recipient address, subject, the
    rendered email, and its items.
  - `google_calendar_connections` and `gmail_connections`: connection status only. A row means connected, and shows
    the Google account label or address, the scopes granted, when it was connected, and the last error. An empty list
    means not connected.
  - `agent_runs`: every question the account asked the recruiting agent, with when it was asked, its status, the
    question as stored (email addresses and phone numbers in it were already replaced when it was saved), and the answer
    state 1stSeen stored. `agent_tool_calls` and `model_usage` are the steps each question ran and the model calls it
    made, if any.
- **`referenced_roles`** and **`referenced_companies`**: the names of the public roles and companies those rows point
  at, so the file can be read without looking ids up.

**Never in the export:** an OAuth access or refresh token, its ciphertext, or its expiry. The selects name their columns
and never read the token columns, and the route checks the finished file for any credential-shaped field or any value
in the stored token format and refuses to send it if one is found.

Forecasts, openings, and evidence are public data 1stSeen collects about employers, not the user's, so they are not in
the file beyond the names above.

## Delete account

"Delete account" opens a dialog that lists what will be deleted and offers the download first. The user types
**delete my account** (case and surrounding spaces do not matter) and presses "Delete account". The route checks the
phrase again.

### Google Calendar events

If Google Calendar is connected and 1stSeen has synced events into it, the dialog asks what happens to them, the same
choice the calendar disconnect offers:

- **Keep them in my calendar** (selected by default): they stay as ordinary events in the user's calendar; 1stSeen can
  no longer change them.
- **Remove them**: 1stSeen deletes each event it created before it revokes its access. If Google Calendar fails, the
  deletion goes on and the page the user lands on says some events may still be there.

Events a previous disconnect already detached cannot be removed (1stSeen has no access left); they stay. The page the
user lands on says when events remain in their calendar.

### What happens, in order

**Deleting the user's data is 1stSeen's to guarantee. Revoking access at Google is not: only Google can do it.** So
nothing Google does, or fails to do, stops a deletion.

1. **Synced events**, if the user chose to remove them. If Google Calendar fails, the deletion goes on.
2. **Google is asked to revoke access** at `https://oauth2.googleapis.com/revoke`, once for each stored connection
   (Google Calendar and Gmail), with the stored refresh token, which revokes the whole grant. Whatever Google answers,
   or if it does not answer, the deletion goes on.
3. **Every row the account owns is deleted, in one transaction** (`delete_account_data`), except its profile: digest
   deliveries and items, synced-event records, readiness milestones, follows (both tables), priority companies,
   preferences, both Google connections with their encrypted tokens, and the account's agent questions with their tool
   calls and model-usage rows.
4. **The sign-in is deleted** with the Supabase Auth admin API. Its profile, sessions, refresh tokens, and identities go
   with it (foreign keys with `ON DELETE CASCADE`).
5. **Supabase Auth's leftovers are removed and the deletion is recorded** (`finish_account_deletion`): the account's
   rows in `auth.flow_state` (PKCE state that has no foreign key, so Supabase keeps it after deleting a user) and its
   entries in `auth.audit_log_entries` (Supabase's sign-in history, which keeps the id and email of every deleted user
   in JSON). Then one row is added to `account_deletions` (below).
6. **The session cookies are cleared**: every `sb-*` cookie, and the short-lived `firstseen_*` OAuth state cookies,
   which carry the user id.
7. The browser goes to **`/account/deleted`**, which says: "Your account has been deleted. Your 1stSeen account and
   everything it held are gone: your answers, watchlist, readiness plans, calendar and digest records, Google
   connections, and the questions you asked the agent. You have been signed out, and this cannot be undone." When
   Google did not confirm a revocation it adds, first: "Remove 1stSeen's access in your Google Account." with a link to
   `https://myaccount.google.com/connections`.
8. **After the response**, a token Google did not answer about is offered to Google again, three times over about 15
   seconds, from memory only: its row is already deleted and the token is never written anywhere. When Google
   confirms, the anonymous `account_deletions` row is updated (`record_late_google_revocation`). This is best effort:
   the Worker may stop before it finishes, which is why the user has already been told to check their Google Account.

Signing in with the old address and password afterwards fails like any unknown account. The address can be used to
create a new, empty account.

### When something fails

The rule: **the user is never told the account is deleted unless the sign-in is gone, is never told access at Google
was revoked unless Google said so, and once the account is gone no Google token is left in the database.**

| What fails | What is true afterwards | What the user is told |
| --- | --- | --- |
| Removing synced events (step 1) | The deletion goes on. Some events may still be in the user's calendar; `account_deletions` records `not_removed`. | The landing page adds: "Google Calendar did not let 1stSeen remove every event it added, so some may still be in your calendar as ordinary events. Delete them in Google Calendar if you no longer want them." |
| Google answers 200 | Revoked. | |
| Google answers 400 `invalid_token` | The token was already expired or revoked: counted as revoked. | |
| Google does not answer: network failure, timeout (10 s), 408, 429, or 5xx (step 2) | The deletion goes on; the token is deleted with its row and retried from memory after the response (step 8). Recorded `unconfirmed` until a retry is confirmed. | The landing page adds, first: "Remove 1stSeen's access in your Google Account. Your data is deleted, but Google did not confirm that the access you gave 1stSeen is revoked, so 1stSeen may still be listed there. Go to myaccount.google.com/connections, choose 1stSeen, and delete its connection. 1stSeen no longer stores the token and will ask Google again for a short while, but only Google can confirm the access is gone." |
| A token cannot be revoked at all: it no longer decrypts, or Google gives any other answer | The deletion goes on and the token is deleted with its row; repeating the request could not succeed, so it is not retried. Recorded `not_revocable`. | The same note as above. |
| Deleting the rows (step 3) | The transaction rolls back: nothing is deleted. Tokens Google revoked in step 2 stay in their rows, dead. | "1stSeen could not delete your data, so your account was not deleted. Try again." Plus what was already done: events removed, access already revoked. |
| Deleting the sign-in (step 4) | The data is gone, but the account can still sign in, holding nothing. Repeating the request finishes it. If the delete errs but the user is in fact gone (a repeated request, a lost answer), it counts as deleted. | "Your data was deleted, but your sign-in account was not. Try again to finish deleting it." |
| Removing Supabase Auth's leftovers or recording (step 5) | The account is deleted; its auth audit entries and PKCE rows may remain. The server logs the failure without the id. | The account is deleted, and the user is told so. |
| The request does not finish in the browser | Unknown to the page. | "The request did not finish, so 1stSeen cannot say whether your account was deleted. Reload this page: if you are still signed in, your account exists and you can try again." |

Google is asked before any row is deleted because the stored token is the only way 1stSeen can revoke a grant: once the
row is gone, only the retry held in memory, or the user on Google's own page, can remove it. Asking first is not waiting
for Google: a deletion never depends on Google's answer.

### What is kept

- **`account_deletions`**, one row per completed deletion, with no personal data: the day (no time), how many rows
  were deleted from each table, what Google said about each connection (`not_connected`, `revoked`,
  `already_invalid`, `unconfirmed`, `not_revocable`), and whether synced events were `none`, `kept`, `removed`, or
  `not_removed`. No account id, no email. Service role only.
- **Events the user chose to keep** in their Google Calendar, and digests already delivered to their Gmail inbox: they
  are the user's, in the user's Google account.
- **Outside the database**: Supabase's hosted platform keeps its own request logs (including Auth's) for the plan's log
  retention period, and Cloudflare keeps its request logs. 1stSeen cannot delete those. The deletion writes no account
  id or email to the Worker's logs.

### Why the agent questions are deleted

`agent_runs.initiated_by` is `ON DELETE SET NULL`, so the database alone would keep every question the user asked,
detached from the account. A question is something the user typed, often about their own plans, and the run also keeps
the user's id inside its stored state and its tool calls' inputs, where no foreign key reaches. So the account's runs
are deleted, with their tool calls and model-usage rows. The runs are those started by the account, or with its id as
the actor in the stored state or a tool call's input (`account_agent_run_ids`), which also catches runs stored before
`initiated_by` was recorded. The cost is that model-usage accounting loses those rows; a deleted user's questions are
not needed for it.

## The database side

Migration `202608140037_account_deletion.sql` is purely additive:

- `account_agent_run_ids(uuid)`, `delete_account_data(uuid)`, and `finish_account_deletion(...)`, executable only by
  `service_role`. The first two are `SECURITY INVOKER`. `finish_account_deletion` is `SECURITY DEFINER` with an empty
  `search_path`, because `service_role` holds nothing in the `auth` schema; it touches only `auth.flow_state` and
  `auth.audit_log_entries`, only for the given id, and refuses while that user or its profile still exists.
- `account_deletions`, with RLS on, no policy, and nothing granted to `anon` or `authenticated`.
- Four partial indexes, so finding and deleting a user's agent runs does not scan the audit tables.

`npm run verify:supabase` checks the new table and functions, and now also checks that every `SECURITY DEFINER` function
in `public` pins its `search_path` and, unless it is a trigger function, is not callable by a browser role.

`delete_account_data` deletes digests before readiness milestones on purpose. `email_digest_items.readiness_milestone_id`
is `ON DELETE RESTRICT`, which is checked row by row during a cascade, so deleting an auth user whose digest listed one of
their own milestones fails with a foreign-key error when the cascade reaches the milestone first. That is also why a user
must never be deleted from the Supabase dashboard or with the admin API alone: that path fails for such a user, and for
everyone else it leaves their agent questions, PKCE state, and audit history behind.

## Adding a table that holds user data

`tests/integration/account-deletion.test.mjs` reads from the catalog every column that can hold a user id (each foreign
key to `auth.users(id)` or `public.profiles(id)`, and each uuid or text column named like a user reference) and every
public table those rows take with them through `ON DELETE CASCADE`. It fails until the new table has:

1. a seeded row in the test;
2. a delete in `delete_account_data` (a new migration, since shared migrations are never edited);
3. a key in the export (`OWNED_TABLES` in `lib/account/data.ts`, or its own read there).

Supabase Auth's own tables that `auth.users` cascades into are covered by that cascade, which the test reads from the
catalog. After a deletion the test scans every row of every table outside the system schemas as text for the account's
id and email, and there must be none.
