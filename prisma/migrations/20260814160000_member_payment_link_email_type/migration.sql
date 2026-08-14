-- New EmailType for the on-request payment-link email (issue #45). Sent by
-- hand from the member detail page when a member asks for their payment link
-- again; there is no automatic trigger.
ALTER TYPE "EmailType" ADD VALUE 'MEMBER_PAYMENT_LINK';
