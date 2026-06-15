-- AlterEnum
-- Adds the per-match goal-scorer event type. Already applied to the dev DB via
-- `prisma db push`; this file back-fills the migration history (marked applied
-- with `prisma migrate resolve --applied`) so there is no drift / reset.
ALTER TYPE "EventType" ADD VALUE 'match_scorer';
