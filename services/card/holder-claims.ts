// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type {
  CitizenPayEventOutcome,
  CitizenPayEventPayload,
  EventFund,
} from "@/services/citizenpay/events";
import type { CardHolderClaimStatus } from "@/services/db/generated/enums";

// STUB — replaced by the events worker. Signatures are the contract the UI
// codes against.

export const HOLDER_EVENT_TYPES = ["card.attached", "card.detached", "card.claim_pending"] as const;

export type CardHolderClaimListItem = {
  id: string;
  status: CardHolderClaimStatus;
  serial: string;
  cardId: string | null;
  cardNumber: number | null;
  holderRef: string;
  proof: string | null;
  member: { id: string; firstName: string; lastName: string; email: string } | null;
  requestedAt: Date;
  decidedAt: Date | null;
};

export async function listCardHolderClaims(_fundId: string): Promise<CardHolderClaimListItem[]> {
  return [];
}

export async function handleCardHolderEvent(
  _fund: EventFund,
  _payload: CitizenPayEventPayload,
): Promise<CitizenPayEventOutcome> {
  return { outcome: "IGNORED", detail: "stub" };
}
