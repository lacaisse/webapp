// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Roles a co-administrator can be invited as / assigned. VIEWER exists in the
// FundRole enum but is intentionally not offered through the team UI yet.
// OPERATOR is a restricted role — manages cards + members only.
// Grant rules (enforced in the server action, not here): OWNER may grant
// OWNER, ADMIN or OPERATOR; ADMIN may grant ADMIN or OPERATOR.
export const INVITABLE_ROLES = ["OWNER", "ADMIN", "OPERATOR"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const InviteFundMemberSchema = z.object({
  email: z.string().email({ error: "team.errors.emailInvalid" }),
  role: z.enum(INVITABLE_ROLES, { error: "team.errors.roleInvalid" }),
});

export type InviteFundMemberInput = z.infer<typeof InviteFundMemberSchema>;
