# Email intelligence digests

1stSeen builds each digest from deterministic, user-scoped records: the latest watched-role forecasts, material `forecast_changes`, confirmed `historical_opening_events`, and persisted networking, referral-contact, and resume readiness milestones. The default wording path does not call an LLM. Any later wording model may reorder or polish supplied items, but its output must retain the typed item keys and may not add or change dates, events, confidence, or evidence semantics.

## Gmail OAuth setup

1. Create or select a Google Cloud project and enable the **Gmail API**.
2. Configure the OAuth consent screen and add test users while the application remains in testing mode.
3. Add the narrow `https://www.googleapis.com/auth/gmail.send` scope plus `openid` and `email` for identifying the connected delivery address.
4. Create a **Web application** OAuth client.
5. Add exact redirect URIs:
   - local: `http://localhost:3000/api/integrations/gmail/callback`
   - production: `https://YOUR_DOMAIN/api/integrations/gmail/callback`
6. Configure the server environment:

```dotenv
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_REDIRECT_URI=http://localhost:3000/api/integrations/gmail/callback
EMAIL_TOKEN_ENCRYPTION_KEY=... # 32 random bytes, base64url encoded
EMAIL_DIGEST_SEND_ENABLED=false
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

OAuth secrets, refresh tokens, and the encryption key are server-only. Tokens use the `v2` AES-GCM format
with provider/user-bound authenticated data before persistence, and the Gmail credential table has no client
grants. The one-time OAuth state is also bound to the initiating user. Connections created with the earlier
unbound token format must reconnect. Offline access is requested so an expired access token can be refreshed
without asking for consent on every explicit send.

## Development delivery safety

`EMAIL_DIGEST_SEND_ENABLED` defaults to `false`. Preview remains available in that state, but the send endpoint rejects delivery. A send occurs only when all of these are true:

- the user signed in to 1stSeen;
- the user explicitly connected Gmail;
- server configuration enables sending;
- the user previews their current data, checks the delivery confirmation, and presses **Send this digest**.

There is no scheduled or background send path in this prototype. Disconnect revokes the Google grant on a best-effort basis and deletes encrypted credentials while retaining delivery audit history. Deleting the account deletes that history too, after revoking the grant (`docs/account-data.md`).

Each digest has a SHA-256 fingerprint over its versioned structured inputs. A unique database constraint prevents the same user and fingerprint from being sent again. If Gmail accepts a message but persistence confirmation fails, the delivery remains `sending` and automated retry is blocked, favoring duplicate prevention over an unsafe second send.

Official references: [OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth security practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices), [create and send Gmail messages](https://developers.google.com/workspace/gmail/api/guides/sending), and [`users.messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).
