// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: npx tsx services/bank-sync/matching/parse.test.mjs
import {
  parseCardSerial,
  parseStructuredCommunication,
} from "./parse.ts";

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${label} → ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
};

console.log("== SERIAL (definite) ==");
const serials = {
  "class-04516F320A1291": "04516F320A1291",
  "Class-040A51320A1291": "040A51320A1291",
  "CLASS-046D6AAA1D1291": "046D6AAA1D1291",
  "class 04F428320A1290": "04F428320A1290", // space, no dash
  "Class - 044981AA1D1291": "044981AA1D1291", // spaced dash
  "class-049b16AA1D1290": "049B16AA1D1290", // lowercase hex
  "040D98320A1290": "040D98320A1290", // bare, no prefix
  "class-04255BAA1D1290": "04255BAA1D1290",
  "class-040FF320A1290": "040FF320A1290", // 13 chars
  "Class-04DF28320A1290": "04DF28320A1290",
};
for (const [ref, want] of Object.entries(serials)) {
  check(ref, parseCardSerial(ref), want);
}

console.log("\n== STRUCTURED COMMUNICATION (definite) → card number ==");
const ogms = {
  "000/0000/01717": 17,
  "+++000/0000/03131+++": 31,
  "000/0000/04242": 42,
  "000/0000/16366": 163,
  "000/0000/15760": 157,
  "000/0000/16164": 161,
  "000/0000/02020": 20,
  "000/0000/01010": 10,
};
for (const [ref, want] of Object.entries(ogms)) {
  check(ref, parseStructuredCommunication(ref), want);
}

console.log("\n== NEITHER (→ manual / name) ==");
const none = [
  "M N GRAU RIBES OU Mme L LEGROS",
  "Cotisation Juin Monteverdi",
  "LA CLASS 000179", // 'class' word but no 14-hex serial, 6-digit not OGM
  "000038", // short numeric, not a 12-digit OGM
  "", // empty
];
for (const ref of none) {
  check(`serial(${JSON.stringify(ref)})`, parseCardSerial(ref), null);
  check(`ogm(${JSON.stringify(ref)})`, parseStructuredCommunication(ref), null);
}

console.log("\n== CROSS-CONTAMINATION GUARDS ==");
// A serial ref must NOT be read as an OGM, and an OGM ref must NOT be read as a serial.
check("serial ref not an OGM", parseStructuredCommunication("class-04516F320A1291"), null);
check("OGM ref not a serial", parseCardSerial("000/0000/01717"), null);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
