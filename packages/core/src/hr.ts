import { z } from 'zod';

/**
 * Staff expense claims (seventh round; ADR-0010). A claim is submitted with
 * its receipts, approved or rejected by somebody else, or withdrawn by its
 * claimant while it waits; an approved claim is paid back directly or through
 * the next pay run.
 */

export const EXPENSE_CLAIM_STATUSES = [
  'submitted',
  'approved',
  'rejected',
  'withdrawn',
  'paid',
] as const;
export const expenseClaimStatusSchema = z.enum(EXPENSE_CLAIM_STATUSES);
export type ExpenseClaimStatus = z.infer<typeof expenseClaimStatusSchema>;

/** How an approved claim is to be paid back. */
export const EXPENSE_SETTLEMENTS = ['direct', 'payroll'] as const;
export const expenseSettlementSchema = z.enum(EXPENSE_SETTLEMENTS);
export type ExpenseSettlement = z.infer<typeof expenseSettlementSchema>;

/** How it was paid back. */
export const EXPENSE_PAID_VIA = ['cash', 'bank_transfer', 'payroll'] as const;
export const expensePaidViaSchema = z.enum(EXPENSE_PAID_VIA);
export type ExpensePaidVia = z.infer<typeof expensePaidViaSchema>;

/** `EX-000123`. */
export const formatExpenseReference = (reference: number) =>
  `EX-${String(reference).padStart(6, '0')}`;

/** `EX-000123`, `ex123` or `123` → 123. */
export function parseExpenseReference(text: string): number | undefined {
  const match = /^(?:ex-?)?0*(\d{1,9})$/iu.exec(text.trim());
  return match === null ? undefined : Number(match[1]);
}
