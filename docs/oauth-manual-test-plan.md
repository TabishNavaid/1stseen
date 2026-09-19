# Google Calendar and Gmail: manual test plan

Both integrations are complete in code but have never run against Google, because that needs an OAuth
client. This plan is the first real exercise. It takes about fifteen minutes once the client exists.
Run it against the local rig (`docs/local-development.md`) first, then repeat steps 3 onward on the
production domain.

What is already proven without Google, and what is not:

| Proven by unit tests with synthetic tokens (`apps/web/tests/oauth-integrations.test.mjs`) | Only this plan proves |
|---|---|
| AES-256-GCM token encryption round-trips | Google accepts the client, redirect URI, and scopes |
| A token sealed for one user cannot be opened for another | The consent screen shows the right app and scopes |
| A Calendar token cannot be opened as a Gmail token, or the reverse | Token exchange, refresh, and revocation against Google |
| Tampering, a wrong key, or the old `v1` format fail closed | Events actually appear, update, and disappear in Google Calendar |
| Tokens written by the previous implementation still decrypt | A digest actually arrives |
| Google event ids are deterministic per user, kind, and key, and valid for Google | |
| A retry is a no-op; a changed forecast updates the same event | |
| Both integrations report "not configured" without credentials (`integrations-not-configured.test.mjs`) | |

---

## 0. Before you start (one time, about 5 minutes)

1. <https://console.cloud.google.com> → select or create a project.
2. **APIs & Services → Library**: enable **Google Calendar API** and **Gmail API**.
3. **Google Auth Platform → Branding**: app name `1stSeen`, your support email, home page
   `https://firstseen.tabishnavaid.dev`, privacy policy URL on the same domain.
4. **Audience**: user type **External**, publishing status **Testing**, and add your own Google account
   under **Test users**. While in Testing, only listed test users can connect, and Google expires refresh
   tokens after 7 days, so a connection made today will need reconnecting next week. That is expected.
5. **Data access → Add or remove scopes**: add exactly
   `https://www.googleapis.com/auth/calendar.events`, `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.send`. The console labels `calendar.events` and `gmail.send` as
   **sensitive**. If it shows either as restricted, stop: the code requests nothing broader.
6. **Clients → Create client → Web application**. Authorized redirect URIs, both environments:
   - `http://localhost:3000/api/integrations/google-calendar/callback`
   - `http://localhost:3000/api/integrations/gmail/callback`
   - `https://firstseen.tabishnavaid.dev/api/integrations/google-calendar/callback`
   - `https://firstseen.tabishnavaid.dev/api/integrations/gmail/callback`

   Copy the client ID and secret. The same client can serve both integrations.

## 1. Configure (2 minutes)

Generate two keys, one per integration:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Put these in `.env` (local) or the Worker secrets (production). Secrets go in Worker secrets, never vars.

| Variable | Value |
|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID` | client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | `<origin>/api/integrations/google-calendar/callback` |
| `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY` | first generated key |
| `GMAIL_OAUTH_CLIENT_ID` | client ID |
| `GMAIL_OAUTH_CLIENT_SECRET` | client secret |
| `GMAIL_OAUTH_REDIRECT_URI` | `<origin>/api/integrations/gmail/callback` |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | second generated key |
| `EMAIL_DIGEST_SEND_ENABLED` | `false` |

Restart `npm run dev`, then:

```bash
npm run preflight
```

**Expected:** both groups show `set` with no `malformed` rows.

## 2. Precondition: a watched role with milestones (1 minute)

Sign in, open a role that has a forecast, click **Follow**, then **Generate preparation plan**.

**Expected:** milestones appear on the role page, and `/calendar` lists them.

## 3. Google Calendar

| Step | Action | Expected result |
|---|---|---|
| 3.1 | Open `/calendar` | The sync panel says "Connect your Google account", not "not configured" |
| 3.2 | Click **Connect Google Calendar** | Google consent screen names 1stSeen and asks only to manage calendar events |
| 3.3 | Approve | You return to `/calendar?google=connected`; the panel shows your calendar name |
| 3.4 | In Postgres: `select left(access_token_ciphertext, 3), left(refresh_token_ciphertext, 3) from google_calendar_connections;` | Both start with `v2.`; no readable token anywhere in the row |
| 3.5 | Select one networking milestone and one predicted window start, then sync | Response lists both as `created`; both appear in Google Calendar as all-day, free-busy transparent events |
| 3.6 | Open the predicted event in Google Calendar | Title starts `1stSeen forecast:`; description says it is a statistical forecast, not a confirmed company date |
| 3.7 | Sync the same two again | Both `unchanged`; Google shows no duplicate |
| 3.8 | Regenerate the plan so the milestone date changes, then sync | That event is `updated` in place, same event, new date |
| 3.9 | Delete the milestone event in Google Calendar, then sync it again | It is recreated with the same event id, not duplicated |
| 3.10 | Disconnect and choose **keep synced events** | Events stay in Google; `calendar_event_syncs` rows become `detached`; `google_calendar_connections` has no row for you |
| 3.11 | <https://myaccount.google.com/permissions> | 1stSeen no longer has access (the refresh token was revoked) |
| 3.12 | Reconnect, sync one event, disconnect choosing **remove synced events** | The event disappears from Google; mapping rows are deleted |
| 3.13 | Visit `/api/integrations/google-calendar/callback?state=forged&code=x` while signed in | Redirects to `/calendar?google=invalid_state`; no connection row is written |

## 4. Gmail

| Step | Action | Expected result |
|---|---|---|
| 4.1 | Open `/digests` | Preview renders from your watchlist; the Gmail panel offers **Connect Gmail with consent** |
| 4.2 | Connect and approve | Consent asks only to send email on your behalf, plus your email address; you return to `/digests?gmail=connected` |
| 4.3 | Check `gmail_connections` | Token columns start with `v2.`; `google_account_email` is yours |
| 4.4 | Look at the send panel | "Preview-only mode. Actual sends are disabled by server configuration." |
| 4.5 | Set `EMAIL_DIGEST_SEND_ENABLED=true`, restart, tick the consent box, **Send this digest** | Exactly one email arrives at your address; `email_digest_deliveries` has one `sent` row with a Gmail message id |
| 4.6 | Click **Send this digest** again without changes | Refused as already delivered; no second email |
| 4.7 | Set `EMAIL_DIGEST_SEND_ENABLED=false` and restart | Send panel returns to preview-only |
| 4.8 | Disconnect Gmail | Connection row deleted; <https://myaccount.google.com/permissions> no longer lists 1stSeen |

## 5. Afterwards

- Record the date and result of every row above in `docs/production-smoke-test.md`.
- Any failure is a bug report with the step number, not a reason to change the expected result.

## Going beyond test users

Both `calendar.events` and `gmail.send` are sensitive scopes. Until the app passes Google's sensitive
scope verification, every user sees the unverified-app screen, the project is capped at 100 new users
for its whole lifetime (the cap cannot be reset), and refresh tokens are short-lived. Verification needs a
public home page, a privacy policy on the same verified domain (Google Search Console), consent-screen
branding that matches, an unlisted YouTube video showing the consent flow and what each scope is used for,
and a written justification per scope. Google states it typically takes 3 to 5 business days. Neither
scope is restricted, so no third-party security assessment is required.

Sources: [Unverified apps](https://support.google.com/cloud/answer/7454865),
[Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
