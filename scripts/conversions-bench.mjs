// SPDX-License-Identifier: AGPL-3.0-or-later
// Bench of the token conversions (services/convert) on a bench Safe, driving
// the real UI with playwright-core on the installed Google Chrome against a
// running dev server and a LOCAL bench database. Passkey owners sign through
// Chrome's virtual authenticator (CDP WebAuthn domain) restored from the
// state file the passkey bench keeps (scripts/safe-passkeys-bench.mjs).
// Every relayer transaction lands on Gnosis for real and a started
// conversion posts a real CoW order — bench fund only, never a prod Safe.
//
//   BENCH_BASE=http://caisse-test.localhost:3032 BENCH_AUTH=http://auth.localhost:3032 \
//   BENCH_PASSWORD=… BENCH_STATE=/path/to/safe-passkeys-state.json \
//   node scripts/conversions-bench.mjs <command> [--safe <safeId>] [--pair eure-bread] [--amount 0.5] [--headed]
//
// Commands (one browser session each; DB state printed after):
//   status                     — the Safe's conversions and open proposals
//   start                      — as the server-key owner: quote + propose (1 of 2 signatures)
//   sign                       — as a passkey owner: sign the pending step (executes at 2 of 2)
//   continue                   — as the server-key owner: "Propose next step" on a READY conversion
//   withdraw                   — as the proposer: withdraw the pending step (→ READY)
//   cancel                     — cancel the READY conversion
//   wait [--minutes 30]        — reload the Safe page until the conversion leaves FILLING
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { chromium } from "playwright-core";

const BASE = process.env.BENCH_BASE ?? "http://caisse-test.localhost:3032";
const AUTH = process.env.BENCH_AUTH ?? "http://auth.localhost:3032";
const PASSWORD = process.env.BENCH_PASSWORD;
const STATE_FILE = process.env.BENCH_STATE;
const OWNER = process.env.BENCH_OWNER ?? "owner@test.localhost"; // server-key owner (proposes)
const SIGNER = process.env.BENCH_SIGNER ?? "safes-admin@test.localhost"; // passkey owner (co-signs)
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "status";
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const SAFE_ID = opt("safe", "cmvtlod6s0001wguu3bwaqx7s");
const PAIR = opt("pair", "eure-bread");
const AMOUNT = opt("amount", "0.5");
const MINUTES = Number(opt("minutes", "30"));
const HEADED = args.includes("--headed");

if (!PASSWORD || !STATE_FILE) {
  console.error("Set BENCH_PASSWORD and BENCH_STATE.");
  process.exit(2);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------------------
// DB (read-only here)
// ---------------------------------------------------------------------------

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function status() {
  const conv = await db.query(
    `select id, status, round, "converterId", "amountIn", "minOut", "amountOut", "validUntil", "errorMessage", state
       from "FundConversion" where "safeId" = $1 order by "createdAt"`,
    [SAFE_ID],
  );
  const txs = await db.query(
    `select id, nonce, kind, status, operation, "txHash", "conversionId", summary->>'label' as label,
            (select count(*) from "FundSafeSignature" s where s."transactionId" = t.id) as sigs
       from "FundSafeTransaction" t where "safeId" = $1 and kind = 'CONVERSION' order by nonce`,
    [SAFE_ID],
  );
  console.log("conversions:");
  for (const c of conv.rows) {
    const uid = (c.state?.legs ?? []).flatMap((l) => l.results).find((r) => r.kind === "api")?.ref ?? null;
    console.log(
      `  ${c.id} ${c.status} round=${c.round} ${c.converterId} in=${c.amountIn} min=${c.minOut} out=${c.amountOut ?? "-"}` +
        (uid ? `\n    order ${uid}` : "") +
        (c.errorMessage ? `\n    error ${c.errorMessage}` : ""),
    );
  }
  console.log("conversion steps:");
  for (const t of txs.rows) {
    console.log(`  #${t.nonce} ${t.status} op=${t.operation} ${t.label} sigs=${t.sigs} tx=${t.txHash ?? "-"} conv=${t.conversionId ?? "-"}`);
  }
  return conv.rows;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const authenticators = {};

async function saveState() {
  for (const [email, a] of Object.entries(authenticators)) {
    try {
      const { credentials } = await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.authenticatorId });
      if (credentials.length > 0) state[email] = credentials;
    } catch (e) {
      log("could not export credentials for", email, String(e).slice(0, 80));
    }
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
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
}

const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
const context = await browser.newContext({ locale: "en-US" });
// English UI whatever the account's saved locale.
for (const url of [BASE, AUTH]) {
  const u = new URL(url);
  await context.addCookies([{ name: "locale", value: "en", domain: u.hostname, path: "/" }]);
}

async function login(email) {
  const page = await context.newPage();
  await withCdp(page, email);
  await page.goto(`${AUTH}/login?return_to=${encodeURIComponent(`${BASE}/accounts/safes/${SAFE_ID}`)}`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((u) => !u.href.includes("/login"), { timeout: 30_000 });
  await page.goto(`${BASE}/accounts/safes/${SAFE_ID}`);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
  log("signed in", email);
  return page;
}

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

async function settle(page) {
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

async function start(page) {
  await page.getByRole("button", { name: /^convert$/i }).click();
  const dialog = page.getByRole("dialog");
  const pair = dialog.locator("select");
  if ((await pair.count()) > 0) await pair.selectOption(PAIR);
  await dialog.locator('input[type="number"]').fill(AMOUNT);
  await dialog.getByRole("button", { name: /get a quote/i }).click();
  const quote = dialog.locator("dl");
  await quote.waitFor({ timeout: 30_000 });
  log("quote:", (await quote.innerText()).replace(/\s+/g, " "));
  log("notes:", (await dialog.locator("p.text-xs").allInnerTexts()).join(" | "));
  await dialog.getByRole("button", { name: /^propose$/i }).click();
  await answerStepUp(page);
  const result = dialog.getByRole("alert").first();
  await result.waitFor({ timeout: 120_000 });
  log("result:", (await result.innerText()).replace(/\s+/g, " "));
  await settle(page);
}

async function sign(page, expectPasskey) {
  const signButton = page.getByRole("button", { name: /^sign$/i }).first();
  await signButton.waitFor({ timeout: 30_000 });
  await signButton.click();
  const confirm = page.getByRole("button", { name: expectPasskey ? /sign with passkey/i : /^sign$/i }).last();
  await confirm.click();
  if (!expectPasskey) await answerStepUp(page);
  await page.waitForTimeout(5_000);
  await settle(page);
  log("signed pending step as", expectPasskey ? "passkey" : "server key");
}

async function continueStep(page) {
  const button = page.getByRole("button", { name: /propose next step/i }).first();
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  await answerStepUp(page);
  // The proposal result (or its error) renders inside the conversions
  // section; the first alert on the page may be the "Move to passkeys" banner.
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /^conversions/i }) });
  const result = section.getByRole("alert").first();
  await result.waitFor({ timeout: 120_000 });
  log("result:", (await result.innerText()).replace(/\s+/g, " "));
  await settle(page);
}

async function withdraw(page) {
  const button = page.getByRole("button", { name: /^withdraw$/i }).first();
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  await page.getByRole("button", { name: /^withdraw$/i }).last().click();
  await settle(page);
  log("withdrawn");
}

async function cancel(page) {
  await page.getByRole("button", { name: /^cancel$/i }).first().click();
  await page.getByRole("button", { name: /cancel conversion/i }).click();
  await settle(page);
  log("cancelled");
}

async function waitFill(page) {
  const deadline = Date.now() + MINUTES * 60_000;
  while (Date.now() < deadline) {
    await page.goto(`${BASE}/accounts/safes/${SAFE_ID}`);
    await settle(page);
    const rows = await db.query(`select status from "FundConversion" where "safeId" = $1 and status = 'FILLING'`, [SAFE_ID]);
    if (rows.rowCount === 0) {
      log("no conversion filling any more");
      return;
    }
    log("still filling; next check in 45 s");
    await page.waitForTimeout(45_000);
  }
  log("gave up waiting");
}

try {
  if (command === "status") {
    await status();
  } else {
    const email = command === "sign" ? SIGNER : OWNER;
    const page = await login(email);
    if (command === "start") await start(page);
    else if (command === "sign") await sign(page, email !== OWNER);
    else if (command === "continue") await continueStep(page);
    else if (command === "withdraw") await withdraw(page);
    else if (command === "cancel") await cancel(page);
    else if (command === "wait") await waitFill(page);
    else throw new Error(`unknown command ${command}`);
    await status();
  }
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  await saveState().catch(() => undefined);
  await browser.close();
  await db.end();
}
