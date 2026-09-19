# Google Calendar integration

1stSeen syncs only readiness milestones and forecast boundaries that a signed-in user explicitly selects. It never bulk-syncs a watchlist. Forecast events are titled `1stSeen forecast: …` and state that the date is statistical, not confirmed.

## Google Cloud setup

1. Create or select a Google Cloud project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. Add the Calendar events scope:
   `https://www.googleapis.com/auth/calendar.events`.
3. While the consent screen is in testing mode, add the Google accounts that will test 1stSeen as test users.
4. Create an OAuth client with application type **Web application**.
5. Add an exact authorized redirect URI for every environment:
   - local: `http://localhost:3000/api/integrations/google-calendar/callback`
   - production: `https://YOUR_DOMAIN/api/integrations/google-calendar/callback`
6. Set the server environment variables below and restart the web application.

```dotenv
GOOGLE_CALENDAR_CLIENT_ID=...
GOOGLE_CALENDAR_CLIENT_SECRET=...
GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3000/api/integrations/google-calendar/callback
GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY=... # 32 random bytes, base64url encoded
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Generate the encryption key once and retain it in the server secret manager. Rotating it requires reauthorizing existing connections because stored tokens cannot be decrypted with a different key. None of these values may use a `NEXT_PUBLIC_` prefix.

The OAuth flow uses authorization-code exchange, PKCE, a short-lived HttpOnly state cookie bound to the
initiating user, offline access, and the Calendar events scope. Access and refresh tokens use the
`v2` AES-GCM format with provider/user-bound authenticated data before storage. The credential table has RLS
enabled and no client role grants. Connections created with the earlier unbound token format must reconnect.

`calendar.events` is not narrow: Google describes it as "view and edit events on all your calendars". The code
uses it only to insert, update, and delete events whose IDs it generated (`deterministicGoogleEventId`) in the
primary calendar; it never lists or reads other events. The callback's request for the primary calendar's name
(`calendars/primary`) needs a calendar or calendars scope, so under this scope Google refuses it and
`google_account_label` stays null. `/privacy/google` states this, and the sync panel's copy says what the consent
screen will show. A narrower scope, `calendar.app.created` (a secondary calendar 1stSeen creates and writes to), is
the recommended follow-up; it changes where events appear, so it is the owner's decision.

## Sync and disconnect behavior

Each selected 1stSeen record has one stable Google event ID and one unique database mapping. Retrying unchanged content is a no-op. A changed date, confidence value, or description updates the same Google event. A retry after an interrupted insert uses the deterministic event ID to recover from Google’s duplicate response.

Users can disconnect while keeping already-created Google events, or disconnect and remove them. Both choices revoke the grant on a best-effort basis and delete the locally stored OAuth credentials. Keeping events marks mappings detached; reconnecting and selecting them again adopts the same deterministic Google event ID.

Deleting the account (`docs/account-data.md`) offers the same keep-or-remove choice for synced events, and unlike a
disconnect it does not proceed while Google leaves the revocation unanswered.

Official references: [OAuth 2.0 for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [create Calendar events](https://developers.google.com/calendar/api/guides/create-events), [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), and [events.update](https://developers.google.com/workspace/calendar/api/v3/reference/events/update).
