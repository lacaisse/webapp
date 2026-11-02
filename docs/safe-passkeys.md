# Passkey-backed Safe owners

Team members own a fund's Safes (standard Safe 1.4.1 on Gnosis, `services/safe/*`) with a
**passkey**: a WebAuthn credential whose P-256 private key is created and kept by the
member's authenticator (Touch ID, Face ID, Windows Hello, a security key, a synced
password manager). La Caisse's server never holds a member key. The Safe owner address is a
small on-chain contract — a `SafeWebAuthnSignerProxy` from the Safe passkey module v0.2.1
(`safe-global/safe-modules`, `modules/passkey`) — that verifies the passkey's signatures
through EIP-1271.

The previous model (one secp256k1 key per fund × member, AES-GCM encrypted in
`FundSigner.privateKeyEnc`, signed server-side) is **legacy**: no new server-held key is ever
created, a stored one only still signs on Safes that list it as a `MEMBER` owner, and every
such Safe shows a guided migration to passkeys.

## Owner kinds

| `FundSafeOwner.kind` | Address | Signs | Row |
| --- | --- | --- | --- |
| `PASSKEY` | the member's signer contract | WebAuthn ceremony in the browser, contract signature | `FundPasskeySigner` (`passkeyId`) |
| `MEMBER` (legacy) | server-held EOA | server-side EIP-712, until migrated | `FundSigner` (`signerId`) |
| `EXTERNAL` | any wallet | Safe{Wallet} | — |

`FundPasskeySigner` holds, per (fund, user): the signer contract `address`, the WebAuthn
`credentialId`, the public key coordinates `publicKeyX` / `publicKeyY`, the `verifiers` word
the address was derived with, the signature `counter`, and the credential's
`backupEligible` / `backupState` flags from the last ceremony. One active row (`replacedAt`
null) per (fund, user); a replacement for a lost device supersedes the old one.

Contract owners are **not** configuration drift: `describeSafeConfigDrift` still checks only
singleton, guard, modules and fallback handler.

## Chain pieces (Gnosis, chain 100)

| Piece | Address |
| --- | --- |
| `SafeWebAuthnSignerFactory` | `0x1d31F259eE307358a26dFb23EB365939E8641195` |
| RIP-7212 P-256 precompile | `0x0000000000000000000000000000000000000100` |
| Fallback verifier (`DaimoP256Verifier`) | `0xc2b78104907F722DABAc4C69f826a522B2754De4` |

`verifiers` (the module's `P256.Verifiers`, a `uint176`) = precompile `<< 160 | fallback` =
`0x0100c2b78104907f722dabac4c69f826a522b2754de4` (`passkeyVerifiersFor` in `config.ts`). It
is part of the CREATE2 salt, so it is frozen on the row at registration and never recomputed.

The signer address comes from `factory.getSigner(x, y, verifiers)` (`relayer.ts
predictPasskeySignerAddress`); the relayer deploys the proxy with `factory.createSigner`
(`deployPasskeySigner`, idempotent: nothing is sent when the address already has code). The
proxy must exist before a Safe lists it as owner — a Safe deploys fine with a code-less
owner, but the first `checkNSignatures` would then fail `GS024`.

## Registration ceremony (`passkey-actions.ts`, `passkey-signers.ts`, `passkey-webauthn.ts`)

1. `startSigningPasskeyRegistrationAction` (ADMIN of the fund, step-up gated) mints a
   single-use challenge (a `Verification` row, 5 min) and returns
   `PublicKeyCredentialCreationOptionsJSON`: `rp.id` = the apex (`APP_DOMAIN`, same as the
   login plugin), user name / display name `Signing key · <fund name> · <email>` so pickers
   tell it apart from the login passkey, user handle = `sha256("la-caisse:safe-signer:
   <fundId>:<userId>")` (distinct from the login handle, so a platform authenticator keeps
   both and a replacement on the same device overwrites the lost one), ES256 only,
   `userVerification: required`, `attestation: none`.
2. The browser runs `navigator.credentials.create` (`@simplewebauthn/browser`).
3. `finishSigningPasskeyRegistrationAction` consumes the challenge, verifies the attestation
   (`@simplewebauthn/server`: challenge, origin = the request host, rpID, user
   verification), pulls `(x, y)` out of the COSE key, reads the BE / BS flags, derives the
   signer address, writes the `FundPasskeySigner` row (marking the previous active one
   `replacedAt` when the start was a `replace`), then deploys the proxy. A deployment failure
   leaves a retryable row (`deployedAt` null): `ensurePasskeySignerDeployed` finishes it on the
   next use, or the member's card offers "Retry deployment".

Where: the **"Your signing passkey"** card on `/accounts` (register / replace), inline in
the create-Safe form for the current user, and in the migration banner.

## Signing ceremony

1. The browser calls `navigator.credentials.get` with `allowCredentials` restricted to the
   member's signing credential for this fund and **challenge = the 32-byte `safeTxHash`**
   (base64url, no padding, 43 characters), `userVerification: required`.
2. `signTransactionWithPasskeyAction` verifies the assertion against the stored credential
   (challenge, origin, rpID, UV flag, P-256 signature), records the counter and backup flags,
   and — since the member just proved possession with user verification — mints the step-up
   proof for the session (`issueRecentAuthProof`, method `passkey`): one tap is both the
   step-up and the signature.
3. The assertion becomes the module's signature bytes
   (`passkey-signature.ts encodeWebAuthnSignature`):
   `abi.encode(bytes authenticatorData, string clientDataFields, uint256 r, uint256 s)` where
   `clientDataFields` is everything the browser put after `"challenge":"…",` in
   `clientDataJSON` (the contract rebuilds `{"type":"webauthn.get","challenge":"<b64url>",
   <fields>}` and signs over `sha256(authenticatorData ‖ sha256(clientDataJSON))`). `s` is
   normalised to low-s; only the UV flag (0x04) is enforced by the contract.
4. The core (`proposals.ts signTransactionWithPasskey`) asks the signer contract
   `isValidSignature(bytes32, bytes)` by `eth_call` (`relayer.ts verifyContractSignature`) —
   the same EIP-1271 judgement the Safe makes — then stores the row as a **standalone Safe
   contract signature**: static part `r = owner address, s = 65, v = 0`, followed by the
   length-prefixed dynamic part (`contractSignature`). `FundSafeSignature.source = PASSKEY`.
5. `packSignatures` (`safe-tx.ts`) accepts 65-byte static signatures and standalone contract
   signatures together: static parts in ascending owner order, every dynamic part appended
   after all static parts with `s` rewritten to its final offset. `tryExecute` packs mixed
   sets this way; the Transaction Service receives the standalone form (it derives
   `CONTRACT_SIGNATURE` from `v = 0`), and sync imports contract confirmations after the
   owner contract accepted them.

A **proposal by a passkey owner is stored unsigned** (`awaitingSignature: true`); the dialog
runs the signing ceremony right after, so one click proposes and signs. A dismissed prompt
leaves a valid unsigned proposal the member signs from the pending list (or withdraws). The
Transaction Service mirror happens with the first signature.

## New Safes are passkey-only for members

`createSafe` resolves each selected member to their active, deployed signing passkey
(`passkey_missing` otherwise) and lists the signer contracts as `PASSKEY` owners. The
create form disables members without one and lets the current user register inline. Adding a
team member as owner (`ADD_OWNER` / `SWAP_OWNER` with `memberUserId`) means their passkey
signer too. `getOrCreateFundSigner` no longer exists: nothing can create a server-held key.

## Recovery rules (`owner-rules.ts`)

A passkey lives on one person's device. Whenever a Safe has a team owner (passkey or legacy
server key):

- **spare owner**: owners ≥ threshold + 1 — if a member loses their device, the others must
  still reach the threshold and be able to swap in a new key (an owner change that itself
  needs the threshold);
- **one person**: threshold > the number of owners one person holds (their passkey plus any
  legacy key mid-migration) — one person's keys alone never meet the threshold.

So the smallest passkey-only Safe is 2-of-3. Enforced in `createSafe` and every owner /
threshold change (`rules_spare_owner` / `rules_one_person`), and shown live in the dialogs.
All-external Safes are left to their owners' judgement. Owner chips show **Backed up** /
**Device-only** from the credential's BS flag.

## Migration of server-held owners (`migration.ts`, `migration-state.ts`)

Every ACTIVE Safe that still lists a `MEMBER` owner (or a `PASSKEY` owner whose credential was
replaced) shows a persistent **"Move to passkeys"** banner with one row per such owner and
its step:

| step | meaning | who acts |
| --- | --- | --- |
| `register` | the member has no active passkey for this fund | the member ("Create my passkey") |
| `deploy` | passkey registered, signer contract not on chain | the member ("Deploy my owner contract") |
| `propose` | ready | any owner ("Propose swap" → `swapOwner(old → passkey)`) |
| `signing` / `executing` / `failed` | the swap is an ordinary proposal | the other owners sign it; the legacy key may co-sign |

The swap's summary carries `migration: "server_key"` (or `"replaced_passkey"`), so the
history reads "Move X's key to their passkey". Nothing in this path touches a Safe on its
own: it only proposes.

After the swap executes and sync confirms the new owner set, `retireServerKeys` (run by
every sync of the fund) sets `FundSigner.retiredAt` for a key a migration swap moved away,
and **erases the ciphertext** (`privateKeyEnc` null, `keyDeletedAt`) once no unarchived Safe
of the fund lists the address as a current owner. The row stays so signature history keeps
pointing at a person; `signSafeTxWithSigner` refuses an erased key (`server_key_retired`).

**Lost device**: "Replace (lost device)" on the signing-passkey card registers a successor and
marks the old row `replacedAt`; every Safe the old address owns shows the banner with a
`replaced_passkey` row, swapped like a migration. The recovery rules guarantee the other
owners can do it.

## Tests

- `passkey-signature.test.ts`: the module encoding against a vector the real factory on
  Gnosis accepted (`isValidSignatureForSigner` → `0x1626ba7e`, block 49068533), client-data
  parsing, DER → (r, s) with low-s, flags, contract-signature wrapping / parsing.
- `safe-tx.test.ts`: packing of mixed ECDSA + contract sets.
- `owner-rules.test.ts`, `migration-state.test.ts`: the rules and the state machine.
- `proposals.test.ts`: create-flow refusal of server-key owners, passkey-only creation,
  unsigned passkey proposals, contract-signature signing, crossed paths, migration summary.
- `sync.test.ts`: passkey owners found on chain, contract confirmations imported only when
  the owner contract accepts them, retirement + erasure of legacy keys.
- Bench: `scripts/safe-passkeys-bench.mjs` (playwright-core on the installed Chrome, CDP
  virtual authenticator) — see the bench note in the PR.

## Bench note — 2026-11-02 (Gnosis, bench fund `caisse-test`, relayer `0xf5c1…35D6`)

Run with `scripts/safe-passkeys-bench.mjs` against the local bench database (Chrome's
virtual authenticator, `protocol ctap2 / transport internal / UV`), every relayer transaction
on Gnosis for real. Kevin's prod Safe was never touched.

Exercised on chain:

| Step | Result |
| --- | --- |
| Signer contract deployed per member (`createSigner`) | `0xddd5bd43…8383` (Safes Admin, signer `0x00eF…34DD`), `0x02f14f22…9c48` (Second Admin, `0x9AB9…3786`), `0x0e54d326…06cc` (Test Owner, `0x7898…fb1D`); each address re-derived through `getSigner` and found with code |
| Passkey-only Safe created (3 PASSKEY owners, 2-of-3) | `0xaD6c647C1D947E4e28794daC3707329c0977a7a5`, deploy tx `0xc43dcc09…47d6` |
| Add-owner proposed by a passkey owner (stored unsigned, then signed in the same flow) and co-signed by a second passkey | executed by the relayer, tx `0x83b348e4…a881`; both signatures are 417-byte contract signatures (`PASSKEY`); the Safe now lists the external owner |
| Migration swap of a server key to its member's passkey (proposed + co-signed with server keys) | `0xf7e7aa1c…c5b0` (nonce 4, `migration: server_key`); sync turned the owner row into `PASSKEY`, the `FundSigner` got `retiredAt` and its ciphertext erased |
| Second migration swap proposed with a server key and co-signed by the migrated member's **passkey** (mixed ECDSA + contract set in one `execTransaction`) | `0x08d15701…764f` (nonce 5); second `FundSigner` retired + erased |
| Known-answer vector (unit test) | `isValidSignatureForSigner` on the factory answered `0x1626ba7e` at block 49068533 |

Earlier attempts of the same run left two discarded artefacts on chain (signer proxies
`0xc704…df5a`, `0xCe7d…5B5d`, `0x5239…2FcE` and Safe `0xC4F1…40Ae`, deploy `0x3144e275…ac04`):
the virtual authenticators were re-created between runs, so those credentials can no longer
answer. The script now exports / re-imports the authenticator state.

Not exercised:

- Transaction Service mirroring of a contract signature and the import of a contract
  confirmation from Safe{Wallet} (unit-tested only — the bench Safes had no external owner
  until the end).
- A synced ("backed up") passkey: the virtual authenticator reports device-only, so the
  "Backed up" chip was only seen in its device-only state.
- The lost-device replacement flow end to end (state machine and rules unit-tested; the
  banner's `replaced_passkey` rows share the swap path that ran).
- A token transfer signed by passkeys (the Safes hold no funds; the owner change exercised
  the same `execTransaction` path).
- Real platform authenticators (Touch ID / iCloud Keychain, Android, security keys) and
  production RP id `lacaisse.eu`; in dev the RP id is the fund host (`passkey-rp.ts`).
