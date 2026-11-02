// SPDX-License-Identifier: AGPL-3.0-or-later
// Bench of the passkey-backed Safe owners (docs/safe-passkeys.md) against a
// running dev server and a LOCAL bench database, with Chrome's virtual
// authenticator (CDP WebAuthn domain) standing in for the members'
// devices. Drives the real UI with playwright-core on the installed Google
// Chrome; every relayer transaction lands on Gnosis for real (the bench
// relayer pays), so run it against a bench fund only — never a prod Safe.
//
//   BENCH_BASE=http://caisse-test.localhost:3031 \
//   BENCH_AUTH=http://auth.localhost:3031 \
//   BENCH_PASSWORD=… BENCH_USERS=safes-admin@test.localhost,safes-admin2@test.localhost,owner@test.localhost \
//   BENCH_LEGACY_SAFE=Bench \
//   node scripts/safe-passkeys-bench.mjs [--headed] [--skip-create] [--skip-migrate]
//
// Steps: (1) each member registers a signing passkey (step-up by password,
// then the ceremony) and the relayer deploys their signer contract; (2) the
// first member creates a 2-of-3 passkey-only Safe; (3) they propose an
// add-owner (external) and sign it with the passkey in the same flow, the
// second member signs with theirs → the relayer executes a mixed passkey
// set; (4) on the legacy Safe (server-key owners), the first member
// proposes the swap of their server key for their passkey, the third
// member co-signs with the server key → executed, synced, key retired;
// (5) a swap for the second member is proposed with a server key and
// signed by the first member's PASSKEY → a mixed ECDSA + contract set on
// chain. Prints what happened; exits non-zero on the first failure.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const BASE = process.env.BENCH_BASE ?? "http://caisse-test.localhost:3031";
const AUTH = process.env.BENCH_AUTH ?? "http://auth.localhost:3031";
const PASSWORD = process.env.BENCH_PASSWORD;
const USERS = (process.env.BENCH_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LEGACY_SAFE = process.env.BENCH_LEGACY_SAFE ?? "Bench";
const HEADED = process.argv.includes("--headed");
const SKIP_CREATE = process.argv.includes("--skip-create");
const SKIP_MIGRATE = process.argv.includes("--skip-migrate");
// --mirror: on BENCH_SAFE_ID (a Safe with an EXTERNAL owner), propose a
// threshold change with a passkey, check the Safe Transaction Service got the
// proposal with its contract signature, have a second passkey confirm it.
const MIRROR = process.argv.includes("--mirror");
const MIRROR_SAFE_ID = process.env.BENCH_SAFE_ID ?? null;
const TX_SERVICE = process.env.SAFE_TX_SERVICE_URL ?? "https://api.safe.global/tx-service/gno/api";
const EXTERNAL_OWNER = process.env.BENCH_EXTERNAL_OWNER ?? "0x308bCBa768Ad9a1d95f4a64F7ee309fABB9963a4";
// Display names of the users (the migration banner shows names, not emails).
const NAMES = (process.env.BENCH_NAMES ?? "").split(",").map((s) => s.trim());
// The virtual authenticators' credentials, exported after every run and
// re-imported at the start of the next, so a passkey registered in one run
// still answers in a later one (a fresh authenticator knows nothing).
// Kept under the project's git-ignored `.bench/` folder (not a shared tmp dir).
const STATE_FILE =
  process.env.BENCH_STATE ??
  join(dirname(fileURLToPath(import.meta.url)), "..", ".bench", "safe-passkeys-state.json");

if (!PASSWORD || USERS.length < 3) {
  console.error("Set BENCH_PASSWORD and BENCH_USERS (three admins of the bench fund).");
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { passkeys: {}, safe: null, txs: [] };

function loadState() {
  try {
    return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}
const state = loadState();
const authenticators = {}; // email → { cdp, authenticatorId }

async function saveState() {
  for (const [email, a] of Object.entries(authenticators)) {
    try {
      const { credentials } = await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.authenticatorId });
      if (credentials.length > 0) state[email] = credentials;
    } catch (e) {
      log("could not export credentials for", email, String(e).slice(0, 80));
    }
  }
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
  log("authenticator state saved to", STATE_FILE);
}

async function withCdp(page, email) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of state[email] ?? []) {
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  }
  if ((state[email] ?? []).length) log("  restored", state[email].length, "credential(s) for", email);
  authenticators[email] = { cdp, authenticatorId };
  return { cdp, authenticatorId };
}

async function login(context, email) {
  const page = await context.newPage();
  await withCdp(page, email);
  await page.goto(`${AUTH}/login?return_to=${encodeURIComponent(`${BASE}/accounts`)}`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // The exchange sets the fund host's session cookie; in dev the redirect
  // after it may land on the apex (request.url is `localhost` there), so go
  // to the fund host ourselves and check we are in.
  await page.waitForURL((u) => !u.href.includes("/login"), { timeout: 30_000 });
  await page.goto(`${BASE}/accounts`);
  await page.getByText("Your signing passkey").first().waitFor({ timeout: 30_000 });
  log("signed in", email);
  return page;
}

// The step-up dialog may open in front of any sensitive action; answer it
// with the password when it does.
async function answerStepUp(page) {
  const pw = page.locator("#reauth-password");
  try {
    await pw.waitFor({ state: "visible", timeout: 4_000 });
  } catch {
    return false;
  }
  await pw.fill(PASSWORD);
  await page.getByRole("button", { name: /^confirm$/i }).click();
  await pw.waitFor({ state: "hidden", timeout: 15_000 });
  log("  step-up answered");
  return true;
}

async function registerPasskey(page, email) {
  await page.goto(`${BASE}/accounts`);
  const card = page.getByText("Your signing passkey").first();
  await card.waitFor({ timeout: 30_000 });
  if (await page.getByText(/^Registered /).count()) {
    const addr = await page.getByText(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/).first().textContent();
    log("passkey already registered for", email, addr);
    report.passkeys[email] = { address: addr, reused: true };
    return;
  }
  await page.getByRole("button", { name: /create signing passkey/i }).click();
  await page.getByRole("button", { name: /^create passkey$/i }).click();
  await answerStepUp(page);
  await page.getByText("Signing passkey ready").waitFor({ timeout: 120_000 });
  const addr = await page.locator("[role=dialog]").getByText(/^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/).first().textContent();
  const deviceOnly = await page.getByText(/exists on this device only/).count();
  const deployFailed = await page.getByText(/Owner contract not deployed yet/).count();
  log("passkey registered for", email, addr, deviceOnly ? "(device-only)" : "(backed up)", deployFailed ? "DEPLOY FAILED" : "deployed");
  report.passkeys[email] = { address: addr, deviceOnly: Boolean(deviceOnly), deployed: !deployFailed };
  if (deployFailed) throw new Error(`signer deployment failed for ${email}`);
  await page.getByRole("button", { name: /^close$/i }).last().click();
}

async function createSafe(page, name, memberCount) {
  await page.goto(`${BASE}/accounts`);
  await page.getByRole("button", { name: /^new account$/i }).click();
  const safeOption = page.getByRole("radio", { name: /several signatures/i });
  if (await safeOption.count()) await safeOption.click();
  await page.fill("#safe-name", name);
  // base-ui checkboxes: the id is on a hidden input, the clickable part is
  // the role=checkbox button next to it.
  const boxes = page.locator("[role=dialog] [role=checkbox]");
  const n = await boxes.count();
  if (n < memberCount) throw new Error(`only ${n} members listed`);
  for (let i = 0; i < memberCount; i++) {
    const box = boxes.nth(i);
    if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
  }
  await page.getByRole("button", { name: /^create safe$/i }).click();
  await page.waitForURL(/\/accounts\/safes\/[^/?]+/, { timeout: 180_000 });
  const safeId = page.url().match(/\/accounts\/safes\/([^/?]+)/)[1];
  await page.getByText(/^Active$/).first().waitFor({ timeout: 120_000 });
  const address = await page.locator("header").getByText(/^0x[0-9a-fA-F]{40}$/).first().textContent().catch(() => null);
  log("safe created", name, safeId, address);
  report.safe = { id: safeId, name, address };
  return safeId;
}

async function proposeAddExternal(page, safeId) {
  await page.goto(`${BASE}/accounts/safes/${safeId}?tab=signers`);
  await page.getByRole("button", { name: /^add owner$/i }).click();
  await page.getByRole("radio", { name: /external address/i }).click();
  await page.fill(`#add-owner-address-${safeId}`, EXTERNAL_OWNER);
  await page.fill(`#add-owner-label-${safeId}`, "Bench external");
  await page.getByRole("button", { name: /^propose$/i }).click();
  await answerStepUp(page);
  await page.getByText(/Proposed\. It runs once|Signed and executed|Proposed, but not signed/).waitFor({ timeout: 120_000 });
  const text = await page.locator("[role=dialog] [role=alert], [role=dialog] .text-sm").allTextContents();
  log("add-owner proposed:", text.join(" | ").slice(0, 160));
  await page.getByRole("button", { name: /^close$/i }).last().click();
}

async function signPending(page, safeId, expectPasskey) {
  await page.goto(`${BASE}/accounts/safes/${safeId}`);
  const sign = page.getByRole("button", { name: /^sign$/i }).first();
  await sign.waitFor({ timeout: 30_000 });
  await sign.click();
  const confirm = page.getByRole("button", { name: expectPasskey ? /sign with passkey/i : /^sign$/i }).last();
  await confirm.click();
  if (!expectPasskey) await answerStepUp(page);
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle");
  log("signed pending tx as", expectPasskey ? "passkey" : "server key");
}

async function pendingCount(page, safeId) {
  await page.goto(`${BASE}/accounts/safes/${safeId}`);
  await page.waitForLoadState("networkidle");
  return page.getByRole("button", { name: /^sign$/i }).count();
}

async function proposeMigrationSwap(page, safeId, forName) {
  await page.goto(`${BASE}/accounts/safes/${safeId}?tab=signers`);
  await page.getByText("Move to passkeys").waitFor({ timeout: 30_000 });
  const row = page.locator("li", { hasText: forName }).filter({ has: page.getByRole("button", { name: /propose swap/i }) }).first();
  await row.getByRole("button", { name: /propose swap/i }).click();
  await answerStepUp(page);
  await page.waitForTimeout(4_000);
  await page.waitForLoadState("networkidle");
  log("migration swap proposed for", forName);
}

async function proposeThreshold(page, safeId, threshold) {
  await page.goto(`${BASE}/accounts/safes/${safeId}?tab=signers`);
  await page.getByRole("button", { name: /^change threshold$/i }).click();
  const dialog = page.locator("[role=dialog]");
  // Step up to the wanted threshold with the stepper's "More signatures".
  for (let i = 0; i < 6; i++) {
    const current = Number((await dialog.locator("[data-slot=threshold-value], output, [aria-live]").first().textContent().catch(() => "")) || NaN);
    if (current === threshold) break;
    await dialog.getByRole("button", { name: /more signatures/i }).click();
  }
  await dialog.getByRole("button", { name: /^propose$/i }).click();
  await answerStepUp(page);
  await page.getByText(/Proposed\. It runs once|Signed and executed|Proposed, but not signed/).waitFor({ timeout: 120_000 });
  const text = (await dialog.allTextContents()).join(" | ");
  log("threshold change proposed:", text.replace(/\s+/g, " ").slice(0, 200));
  await page.getByRole("button", { name: /^close$/i }).last().click();
}

async function txServicePending(safeAddress) {
  const res = await fetch(`${TX_SERVICE}/v2/safes/${safeAddress}/multisig-transactions/?executed=false&limit=20`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`tx-service HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.results ?? []).map((t) => ({
    safeTxHash: t.safeTxHash,
    nonce: t.nonce,
    confirmations: (t.confirmations ?? []).map((c) => ({ owner: c.owner, signatureType: c.signatureType, bytes: c.signature ? (c.signature.length - 2) / 2 : 0 })),
  }));
}

async function safeAddressOf(page, safeId) {
  await page.goto(`${BASE}/accounts/safes/${safeId}`);
  return page.locator("header").getByText(/^0x[0-9a-fA-F]{40}$/).first().textContent();
}

async function findSafeIdByName(page, name) {
  await page.goto(`${BASE}/accounts`);
  const link = page.locator(`a[href^="/accounts/safes/"]`, { hasText: name }).first();
  await link.waitFor({ timeout: 30_000 });
  const href = await link.getAttribute("href");
  return href.match(/\/accounts\/safes\/([^/?]+)/)[1];
}

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
const contexts = [];
const pages = {};
try {
  for (const email of USERS) {
    const context = await browser.newContext();
    await context.addCookies(
      ["caisse-test.localhost", "auth.localhost", "localhost"].map((domain) => ({
        name: "locale",
        value: "en",
        domain,
        path: "/",
      })),
    );
    contexts.push(context);
    pages[email] = await login(context, email);
  }

  // (1) registration
  for (const email of USERS) await registerPasskey(pages[email], email);

  await saveState();
  const [first, second, third] = USERS;
  const nameOf = (email) => NAMES[USERS.indexOf(email)] || email;
  let safeId = null;
  if (!SKIP_CREATE) {
    // (2) passkey-only Safe
    safeId = await createSafe(pages[first], `Passkey bench ${new Date().toISOString().slice(0, 16)}`, 3);
    // (3) propose + sign with passkeys
    await proposeAddExternal(pages[first], safeId);
    await signPending(pages[second], safeId, true);
    log("pending after two passkey signatures:", await pendingCount(pages[first], safeId));
  }

  if (MIRROR && MIRROR_SAFE_ID) {
    const address = await safeAddressOf(pages[first], MIRROR_SAFE_ID);
    log("mirror bench on", MIRROR_SAFE_ID, address);
    await proposeThreshold(pages[first], MIRROR_SAFE_ID, 3);
    let seen = [];
    for (let i = 0; i < 6 && seen.length === 0; i++) {
      seen = await txServicePending(address);
      if (seen.length === 0) await new Promise((r) => setTimeout(r, 5_000));
    }
    log("tx-service pending after the passkey proposal:", JSON.stringify(seen));
    await signPending(pages[second], MIRROR_SAFE_ID, true);
    await new Promise((r) => setTimeout(r, 5_000));
    log("tx-service pending after the second passkey signature:", JSON.stringify(await txServicePending(address)));
    log("pending in La Caisse:", await pendingCount(pages[first], MIRROR_SAFE_ID));
    report.mirror = { safeId: MIRROR_SAFE_ID, address, seen };
  }

  if (!SKIP_MIGRATE) {
    // (4) migrate the first member's server key on the legacy Safe
    const legacyId = await findSafeIdByName(pages[first], LEGACY_SAFE);
    await proposeMigrationSwap(pages[first], legacyId, nameOf(first));
    await signPending(pages[third], legacyId, false);
    log("pending on legacy safe after swap:", await pendingCount(pages[first], legacyId));
    // (5) mixed set: server-key proposal, passkey co-signature
    await proposeMigrationSwap(pages[third], legacyId, nameOf(second));
    await signPending(pages[first], legacyId, true);
    log("pending on legacy safe after second swap:", await pendingCount(pages[first], legacyId));
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await saveState().catch(() => {});
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
}
