# Dashboard handover: treasury → business connection flow

A treasury (the issuer of a token) controls which businesses accept its
token. The treasury onboards merchants by **email** — the recipient signs
in to Citizen Pay, picks (or creates) a business, and confirms the
attachment. The merchant dashboard owns the confirm screen + the two
button presses below.

The endpoints and routes are already wired on the API. This doc is the slice
the dashboard implements.

---

## What "connected" means

When a business is connected to a treasury, the treasury's `token_address` is
present in:

- `businesses.tokens`
- every `places.tokens` belonging to that business
- every `items.tokens` belonging to that business **that has a non-NULL
  tokens column** (NULL `items.tokens` already means "all tokens allowed",
  so we leave those alone)

The API mutates all three together on accept, and strips all three together
on disconnect. The dashboard does not need to mirror that logic — just call
the accept endpoint with the chosen `business_id` and the API does the
fan-out.

---

## URL the dashboard must serve

The API generates invite links of this shape:

```
{DASHBOARD_BASE_URL}/treasury-invites/{token}
```

No `businessId` segment — the business is picked at accept time. The
recipient gets this URL by email. The dashboard must:

1. Render a page at this route.
2. Fetch the invite metadata (public — no auth) to display.
3. Require the user to be signed in with **the same email** the invite was
   addressed to.
4. Let the user pick (or create) a business they own.
5. Call the accept or reject endpoint when the user clicks.

---

## Step 1 — load the invite (public)

`GET /v2/treasury/invites/{token}` — no auth.

Use this on page load to render the screen before the user signs in.

**Response (200):**

```json
{
  "token": "<same token from the URL>",
  "status": "pending", // pending | accepted | rejected | expired
  "email": "owner@cafe-du-coin.be",
  "expires_at": "2026-05-29T12:34:56Z",
  "accepted_business_id": null,
  "redirect_host": "your-treasury-app.example.com",
  "treasury": {
    "id": "uuid",
    "name": "Brussels Pay",
    "symbol": "BRU",
    "logo": "https://…",
    "color": "#1f6feb",
    "token_address": "0x…"
  }
}
```

`redirect_host` is the host of the treasury's callback URL when one was
set. If non-null, surface it in the confirm UI ("After accepting you'll
be sent back to <host>") so the user understands what happens next. If
null, the user stays on the merchant dashboard after the button press.

**Errors:**

- `404` — invite not found (bad token).
- `400` — token missing in path.

**`status` handling:**

- `pending` — show the confirm UI. (Also check `expires_at` — the API
  returns `status: "expired"` once `expires_at` is in the past, but it's
  belt-and-suspenders to compare client-side too.)
- `accepted` — show "This treasury has already been connected." If
  `accepted_business_id` matches a business the signed-in user owns, link
  to that business's dashboard.
- `rejected` — show "This invite was declined."
- `expired` — show "This invite has expired. Ask the treasury for a new link."

---

## Step 2 — require sign-in with the matching email

The API enforces strict email-match on accept and reject — the JWT user's
email must equal `email` from the invite (case-insensitive). Mirror that
on the UI before the user clicks:

- **Not signed in**: prompt sign-in. Pre-fill the email field with
  `invite.email` and after auth return them to this same
  `/treasury-invites/{token}` URL.
- **Signed in but JWT email ≠ invite.email**: show "This invite is for
  `owner@cafe-du-coin.be`. Sign out and sign in with that email."
  Don't bother sending the request — the API would return `403`.

---

## Step 3 — pick (or create) a business

Once the right user is signed in, present the businesses they own
(`GET /v2/admin/me` or whatever existing endpoint backs the business
picker today). Two situations:

- **User has at least one business**: show a picker. They pick which one
  should accept the treasury's token. Allow a "Create a new business"
  shortcut that leads to the existing business-creation flow and returns
  here.
- **User has no businesses**: deep-link into business creation. After
  the new business is saved, return here so they can accept the invite.

The chosen `businessId` goes in the accept body in step 4.

---

## Step 4 — accept

`POST /v2/admin/treasury-invites/{token}/accept`

Auth: `Authorization: Bearer <supabase JWT>`.

**Request body:**

```json
{ "business_id": "uuid-of-the-business-the-user-picked" }
```

**Success (200):**

```json
{
  "success": true,
  "treasury_id": "uuid",
  "business_id": "uuid",
  "token_address": "0x…",
  "places_updated": 3,
  "items_updated": 12,
  "redirect_uri": "https://your-treasury-app.example.com/citizenpay/callback?token=…&status=accepted&treasury_id=…&business_id=…"
}
```

**Errors:**

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| 400    | `token` or `business_id` missing                                                           |
| 403    | JWT email doesn't match `invite.email`, **or** caller doesn't own the chosen `business_id` |
| 404    | Invite not found                                                                           |
| 409    | Invite is not pending (already accepted, rejected, etc.)                                   |
| 410    | Invite expired                                                                             |

**Post-accept navigation.**

- If the response includes `redirect_uri`, **navigate the browser to that
  URL** (`window.location.assign(...)`). The treasury hosts a callback
  page there that closes the loop on their side. The URL already carries
  `token`, `status=accepted`, `treasury_id`, and `business_id` as query
  params — don't add to it.
- If `redirect_uri` is absent (the treasury didn't set one at mint time),
  navigate to wherever the dashboard's "accepted tokens" page lives for
  that business.

---

## Step 5 — reject

`POST /v2/admin/treasury-invites/{token}/reject`

Same auth, no body. The email-match rule still applies; no `business_id`
needed because rejecting doesn't tie the invite to any business.

**Success (200):**

```json
{
  "success": true,
  "redirect_uri": "https://your-treasury-app.example.com/citizenpay/callback?token=…&status=rejected&treasury_id=…"
}
```

If `redirect_uri` is present, navigate the browser to it (same pattern
as accept) so the treasury sees the rejection.

**Errors:** `400` (token missing), `403` (wrong email), `404`, `409`.

---

## Edge cases the dashboard should handle

1. **Re-issue races.** The treasury can mint a fresh invite while a
   previous one for the same `(treasury, email)` pair is still in the
   user's inbox. The API rejects the older invite the moment the new one
   is created. The user opening an old invite link will see
   `status: "rejected"` — render the "this invite was declined" view.

2. **Wrong email signed in.** Common case: the merchant's Supabase account
   email differs from the email the treasury invited. Don't try to fudge it
   — show the "sign in with X" prompt and let them either re-auth or ask
   the treasury for a new invite to the correct email.

3. **Already connected.** If the user picks a business that already has the
   treasury's token, the accept call still succeeds — the API's `AddToken`
   is idempotent. No special handling needed.

4. **Expired during the confirm screen.** The user could load a pending
   invite at 23:59:59 and click Accept at 00:00:01. The accept endpoint
   returns `410`. Show "this invite has expired" and let them ask the
   treasury for a new one.

5. **New business mid-flow.** If the user creates a brand-new business as
   part of accepting, `places_updated`/`items_updated` will both be `0`
   (no places yet to update). That's fine — the token is on
   `businesses.tokens` and will propagate when places are created via
   normal channels.

---

## Quick reference

| What                           | Method | Path                                        | Auth |
| ------------------------------ | ------ | ------------------------------------------- | ---- |
| Load invite for confirm screen | GET    | `/v2/treasury/invites/{token}`              | none |
| Accept (signed-in recipient)   | POST   | `/v2/admin/treasury-invites/{token}/accept` | JWT  |
| Reject (signed-in recipient)   | POST   | `/v2/admin/treasury-invites/{token}/reject` | JWT  |

The two treasury-side endpoints don't touch the merchant dashboard:

- `POST /v2/treasury/invites` — the treasury calls this with `{ email }` to
  mint + send the invite email.
- `DELETE /v2/treasury/businesses/{businessId}` — the treasury calls this
  to drop the connection. No merchant UI prompt; the token just disappears
  from the business. (If the dashboard wants to show "Treasury X
  disconnected your business" it's a product decision — no event/webhook
  exists yet.)
