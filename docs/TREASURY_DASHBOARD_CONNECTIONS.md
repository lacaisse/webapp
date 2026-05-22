# Treasury dashboard handover: connect / disconnect a business

The treasury controls which businesses accept its token. From the treasury
dashboard the user can:

1. **Invite an email** — generate a one-time invite tied to a merchant's
   email. The API mails the recipient a Citizen-Pay-branded invite. The
   recipient signs in to Citizen Pay, picks (or creates) a business, and
   the token gets attached to that business.
2. **Disconnect a business** — unilaterally strip the token from a connected
   business. No confirmation required from the business side.

Both endpoints are authenticated with the treasury's API key (same auth as
every other `/v2/treasury/*` endpoint). The treasury is implicit — derived
from the API key — so it never appears in the URL or body.

---

## Why email-keyed instead of business-keyed?

When the treasury onboards a merchant, it knows the merchant's email but
**not** which business they'll use Citizen Pay with. Maybe the merchant
hasn't created one yet, maybe they have several. So the invite carries the
email; the merchant picks the business at accept time.

The signed-in user's email **must match** the invite's email exactly
(case-insensitive). Forwarding the link to a different mailbox doesn't help
unless that user signs in with the original email.

---

## Authentication

Send both headers on every request:

```
x-api-key-id: <ethereum address of the API key>
x-api-key:    <api key secret>
```

These are the same credentials used for cards, payouts, etc.

---

## 1. Invite an email

`POST /v2/treasury/invites`

**Request body:**

```json
{
  "email": "owner@cafe-du-coin.be",
  "redirect_uri": "https://your-treasury-app.example.com/citizenpay/callback"
}
```

`email` is required. `redirect_uri` is optional — see "Getting a callback
when the invite is accepted" below.

The API:

1. Rejects any prior pending invite for the same `(treasury, email)` pair
   (the unique partial index allows only one pending row per pair).
2. Mints a fresh token + DB row.
3. Sends the recipient a branded email with an accept button pointing at
   `https://my.citizenpay.xyz/treasury-invites/{token}`.

**Success (201):**

```json
{
  "token": "a3f1…",
  "invite_url": "https://my.citizenpay.xyz/treasury-invites/a3f1…",
  "email": "owner@cafe-du-coin.be",
  "treasury_id": "uuid",
  "expires_at": "2026-05-29T12:34:56Z",
  "status": "pending",
  "email_sent": true,
  "email_sent_at": "2026-05-22T08:12:34Z"
}
```

(`invite_url` is the link the recipient gets in the email — useful for
copying / showing in your dashboard. The treasury callback you'll receive
when the merchant accepts is documented in "Getting a callback when the
invite is accepted" below.)

`email_sent: false` means Resend rejected the message (bad address, quota,
outage). The invite is still valid — surface a "resend" affordance and call
`POST /v2/treasury/invites` again to mint a fresh one if needed.

**Errors:**

| Status | Meaning                                                      |
|--------|--------------------------------------------------------------|
| 400    | Missing or malformed `email`                                 |
| 401    | API key missing / wrong                                      |
| 403    | `redirect_uri` host is not on the allowlist                  |
| 404    | Treasury not found (shouldn't happen with valid auth)        |
| 500    | Internal — safe to retry                                     |

**Re-issue semantics.** Calling this endpoint a second time for the same
email rejects the previous pending invite and mints a brand-new token. The
old email link becomes inert immediately.

**Expiry.** Invites expire 7 days after creation.

---

## 2. Disconnect a business

`DELETE /v2/treasury/businesses/{businessId}`

Strips this treasury's `token_address` from the business + its places +
non-NULL items. The business owner is not prompted — the treasury controls
who accepts its token, so removal is unilateral.

No request body.

**Success (200):**

```json
{
  "success": true,
  "places_updated": 3,
  "items_updated": 12
}
```

Zero counts mean the business wasn't connected — the call is idempotent,
not an error.

**Errors:**

| Status | Meaning                       |
|--------|-------------------------------|
| 400    | `businessId` missing          |
| 401    | API key missing / wrong       |
| 404    | Business not found            |
| 500    | Internal — safe to retry      |

> Note: disconnect does **not** reject pending invites. Invites are keyed
> by email and may target a different business than the one you're
> disconnecting. If you want to revoke an in-flight invite, mint a fresh
> one for the same email (the old one auto-rejects).

**UX recommendation.** Put this behind a "Disconnect <commercial_name>?"
modal — there's no second-stage confirmation on the API side.

---

## End-to-end flow for connect

What the treasury team kicks off vs. what happens automatically:

1. **Treasury dashboard** → `POST /v2/treasury/invites { email }` → gets
   `invite_url` + `email_sent: true`.
2. **API** → Resend → recipient inbox (subject: "Citizen Pay invited you to
   accept BRU"). The button in the email opens
   `https://my.citizenpay.xyz/treasury-invites/{token}`.
3. **Merchant dashboard** renders the confirm screen using the public
   `GET /v2/treasury/invites/{token}` endpoint.
4. **Recipient** signs in to Citizen Pay with the same email, picks (or
   creates) a business, clicks Accept.
5. **Merchant dashboard** → `POST /v2/admin/treasury-invites/{token}/accept`
   with `{ business_id }` (JWT auth, strict email-match enforced server-side).
6. The API appends the token to `businesses.tokens`, every `places.tokens`
   for that business, and every non-NULL `items.tokens`.

The treasury sees the result by re-fetching `GET /v2/treasury/places` —
the business's places now appear in the list. No webhook or status push
exists yet; the dashboard should either poll or offer a "refresh" action.

---

## Getting a callback when the invite is accepted

Pass `redirect_uri` on the mint call to receive a browser-level callback
the moment the merchant accepts or rejects. This mirrors the API-key
registration handoff — same allowlist, same shape.

**Allowlist.** The host of `redirect_uri` must match an entry in
`TREASURY_REGISTER_ALLOWED_DOMAINS` (exact host, or `*.your-domain.com`
wildcard). In production the scheme must be https (localhost excepted).
If the host isn't on the list the mint call returns `403` and no invite
is created — fail fast rather than ship the merchant a link to a dead
callback.

**Accept callback URL.** When the merchant clicks Accept, the API returns
`redirect_uri` in the accept response; the dashboard navigates the browser
to it:

```
{your_redirect_uri}?token={inviteToken}&status=accepted&treasury_id={treasuryId}&business_id={businessId}
```

**Reject callback URL:**

```
{your_redirect_uri}?token={inviteToken}&status=rejected&treasury_id={treasuryId}
```

**What to do on the callback page.** This URL is browser-driven (the
merchant's tab is what lands on it). Verify the outcome server-side
before trusting it — call `GET /v2/treasury/invites/{token}` from your
backend to confirm `status` and read `accepted_business_id`. The
query-string parameters are a hint, not proof.

**No `redirect_uri`?** The accept/reject responses just omit the field
and the merchant dashboard stays on whatever screen it shows after the
button press. The treasury can still discover the outcome by polling the
public lookup:

```
GET /v2/treasury/invites/{token}
```

When accepted, the response includes `accepted_business_id` and
`status: "accepted"`. While pending it's `null`. The lookup is the same
endpoint the merchant dashboard uses to render the confirm screen — safe
to call from the treasury side too.

---

## Quick reference

| What                          | Method | Path                                | Auth    |
|-------------------------------|--------|-------------------------------------|---------|
| Mint an invite + email it     | POST   | `/v2/treasury/invites`              | API key |
| Read an invite by token       | GET    | `/v2/treasury/invites/{token}`      | public  |
| Disconnect a business         | DELETE | `/v2/treasury/businesses/{businessId}` | API key |

Both write endpoints derive the treasury from the API key — never include
the treasury id in the URL or body.
