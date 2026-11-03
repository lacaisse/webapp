// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

// STUB — replaced by the api-sync worker. Signatures are the contract the
// other modules code against.

export type MemberApiSyncOutcome = "ok" | "skipped" | "not_deployed" | string;

export async function syncMemberAtApi(
  _memberId: string,
  _opts: { removedHolderRef?: string } = {},
): Promise<MemberApiSyncOutcome> {
  return "skipped";
}

export async function syncFundMembersAtApi(_fundId: string): Promise<MemberApiSyncOutcome[]> {
  return [];
}

export function scheduleMemberApiSync(
  _memberIds: string | Iterable<string>,
  _opts: { removedHolderRef?: string } = {},
): void {}

export function scheduleFundMemberApiSync(_fundId: string): void {}
