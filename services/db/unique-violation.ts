// SPDX-License-Identifier: AGPL-3.0-or-later

// Prisma P2002 (unique constraint failed) on a unique that includes `field`,
// e.g. "email" on User, "paymentReference" on Member — so
// an insert-and-catch (no SELECT-then-INSERT) can tell which unique spoke.
//
// Where the column name lives depends on the Prisma version and driver:
//   - the classic engine: `meta.target`, the column list (`["email"]`) or
//     a constraint name (`"User_email_key"`);
//   - Prisma 7 with a driver adapter (ours, @prisma/adapter-pg): `meta` holds
//     `driverAdapterError` whose `cause.constraint` names the columns
//     (`{ fields: ["email"] }`) or the index (`{ index: "User_email_key" }`),
//     and `meta.target` is absent;
//   - whichever it was, the message ends with "on the fields: (`email`)" or
//     "on the constraint: `User_email_key`".
// All three are read, so a driver change cannot silently turn a "taken"
// answer into a 500. Pure, unit-tested with hand-built errors.
export function isUniqueViolationOn(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  return namesIn(e).some((name) => name.includes(field));
}

type Constraint = { fields?: unknown; index?: unknown };

function namesIn(e: Error): string[] {
  const names: string[] = [];
  const meta = (e as { meta?: { target?: unknown; driverAdapterError?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) names.push(...target.filter((t): t is string => typeof t === "string"));
  else if (typeof target === "string") names.push(target);

  const cause = (meta?.driverAdapterError as { cause?: { constraint?: Constraint } } | undefined)
    ?.cause;
  const constraint = cause?.constraint;
  if (constraint) {
    if (Array.isArray(constraint.fields)) {
      names.push(...constraint.fields.filter((f): f is string => typeof f === "string"));
    }
    if (typeof constraint.index === "string") names.push(constraint.index);
  }

  const inMessage =
    /on the (?:fields: \(([^)]*)\)|constraint: `([^`]*)`)/.exec(e.message) ?? undefined;
  if (inMessage?.[1]) names.push(...inMessage[1].split(",").map((s) => s.replace(/[`\s]/g, "")));
  if (inMessage?.[2]) names.push(inMessage[2]);
  return names;
}
