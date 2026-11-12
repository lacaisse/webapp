// SPDX-License-Identifier: AGPL-3.0-or-later
// Rotate APP_CRED_KEY: re-encrypt every `*Enc` cell that was sealed under the
// retiring key so it is sealed under the new one. Zero-downtime recipe (also
// in .env.example):
//
//   1. Generate the new key:  openssl rand -hex 32
//   2. In the deployment env set APP_CRED_KEY=<new> and
//      APP_CRED_KEY_PREVIOUS=<old>, deploy. The app now encrypts with the new
//      key and decrypts with either (services/crypto/secret.ts), so nothing
//      breaks while the rows are still on the old key.
//   3. Run this script against the same database with the same two keys:
//
//        npx prisma generate
//        DATABASE_URL='<prod-pooled>' \
//        APP_CRED_KEY=<new> APP_CRED_KEY_PREVIOUS=<old> \
//          npx tsx scripts/rotate-app-cred-key.ts            # dry run
//          npx tsx scripts/rotate-app-cred-key.ts --apply    # writes
//
//   4. Run the dry run once more: every column must report 0 to migrate and
//      0 failed (all "already current").
//   5. Remove APP_CRED_KEY_PREVIOUS from the env and deploy again. Rows the
//      app wrote between step 2 and step 3 are already on the new key.
//
// Columns (all AES-256-GCM envelopes from services/crypto/secret.ts):
//   Fund.tokenMinterPrivateKeyEnc    v1, no binding
//   Fund.citizenPayApiKeyEnc         v1, no binding
//   Fund.citizenPayEventsSecretEnc   v1, no binding
//   FundSigner.privateKeyEnc         v2 bound to "signer:<fundId>:<userId>"
//                                    (legacy v1 rows possible; null once the
//                                    key was deleted)
//
// Each non-null cell is first tried with the NEW key alone: if it opens, the
// row is already current (what a second run after --apply shows). Otherwise
// it is decrypted with the previous key, re-encrypted with the new key with
// the same version and binding, and read back with the new key. A cell that
// neither key opens is reported as failed with its row id — never its
// contents — and `--apply` refuses to write while any row is failed.
//
// `--apply` writes every migrated row in ONE interactive transaction, each
// update conditioned on the cell still holding the envelope that was read
// (the app may re-seal a row concurrently, e.g. a CP key re-issue or the
// signer v1→v2 upgrade): a row that changed underneath makes the whole
// transaction roll back, and a re-run picks the new value up.
//
// Dry run is the default. Nothing here prints a key or a plaintext; the keys
// come from the env only. Exit code 1 whenever any row failed (dry run
// included) so a wrapper notices.
//
// The service layer is `server-only` and won't load under tsx, so the cipher
// is a copy in scripts/lib/app-cred-rotation.ts (format MUST stay in sync
// with services/crypto/secret.ts — scripts/lib/app-cred-rotation.test.ts
// cross-checks the two).

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../services/db/generated/client";
import { pgTlsConfig } from "../services/db/tls";

import { parseHexKey } from "./lib/app-cred-rotation";
import { applyRotation, scanRotation } from "./lib/app-cred-rotation-db";

const APPLY = process.argv.includes("--apply");

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

let keys: { current: Buffer; previous: Buffer };
try {
  keys = {
    current: parseHexKey("APP_CRED_KEY (the NEW key)", process.env.APP_CRED_KEY),
    previous: parseHexKey(
      "APP_CRED_KEY_PREVIOUS (the OLD key)",
      process.env.APP_CRED_KEY_PREVIOUS,
    ),
  };
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (keys.current.equals(keys.previous)) {
  console.error("APP_CRED_KEY and APP_CRED_KEY_PREVIOUS are the same key — nothing to rotate.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(pgTlsConfig(DATABASE_URL, process.env.DATABASE_CA_CERT)),
});

async function main() {
  const { counts, planned, failures } = await scanRotation(prisma, keys);

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — APP_CRED_KEY rotation`);
  console.log("");
  console.log(
    `${"column".padEnd(34)} ${"to migrate".padStart(10)} ${"current".padStart(8)} ${"failed".padStart(7)}`,
  );
  let totalFailed = 0;
  let totalMigrate = 0;
  for (const [label, c] of counts) {
    totalFailed += c.failed;
    totalMigrate += c.migrated;
    console.log(
      `${label.padEnd(34)} ${String(c.migrated).padStart(10)} ${String(c.current).padStart(8)} ${String(c.failed).padStart(7)}`,
    );
  }
  console.log("");

  if (failures.length > 0) {
    console.log("Failed rows (decrypt with neither key, or unreadable envelope):");
    for (const f of failures) {
      console.log(`  ${f.table}.${f.column}  id=${f.id}  ${f.reason}`);
    }
    console.log("");
  }

  if (totalFailed > 0) {
    console.error(
      `${totalFailed} row(s) failed — ${APPLY ? "refusing to write anything" : "--apply would refuse"}. ` +
        "Check that APP_CRED_KEY_PREVIOUS is the key those rows were sealed with.",
    );
    process.exitCode = 1;
    return;
  }

  if (totalMigrate === 0) {
    console.log("Every row is already sealed under APP_CRED_KEY — nothing to do.");
    console.log("APP_CRED_KEY_PREVIOUS can be removed from the deployment env.");
    return;
  }

  if (!APPLY) {
    console.log(`${totalMigrate} row(s) would be re-encrypted. Re-run with --apply to write.`);
    return;
  }

  // One transaction, each update conditioned on the cell still holding the
  // envelope we read; a changed row rolls the whole batch back.
  await applyRotation(prisma, planned);

  console.log(`Re-encrypted ${totalMigrate} row(s) under APP_CRED_KEY.`);
  console.log("Run the dry run again: it must report 0 to migrate and 0 failed before");
  console.log("APP_CRED_KEY_PREVIOUS is removed from the deployment env.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
