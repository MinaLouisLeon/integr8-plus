import { type ChangeContext, recordExpenseClaim, recordExpenseReceipt } from '@integr8/offline';
import { type CapturedFile, discardCaptured } from '~/forms/capture';
import { session } from '~/lib/session';
import { localData } from './local-data';

/**
 * Expense claims from the phone (seventh round; ADR-0010). A claim and its
 * receipt photos are recorded on the phone first, with or without signal, and
 * the sync engine sends them when it can: the claim, then each receipt.
 */

function context(): ChangeContext {
  const opened = localData.changeContext();
  if (opened === undefined) {
    throw new Error('The phone’s database is not open.');
  }
  return opened;
}

function capturedInput(file: CapturedFile) {
  return {
    localPath: file.localPath,
    ...(file.thumbnailPath === undefined ? {} : { thumbnailPath: file.thumbnailPath }),
    contentType: file.contentType,
    byteSize: file.byteSize,
  };
}

/** Claims an expense with its receipt photos; resolves the claim's id on the phone. */
export async function claimExpense(input: {
  categoryId: string;
  spentOn: string;
  amount: string;
  description: string;
  workOrderId?: string;
  receipts: readonly CapturedFile[];
  receiptTitle: (index: number) => string;
}): Promise<string> {
  const { claimId } = await recordExpenseClaim(context(), {
    categoryId: input.categoryId,
    spentOn: input.spentOn,
    amount: input.amount,
    description: input.description,
    ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
    receipts: input.receipts.map((file, index) => ({
      file: capturedInput(file),
      title: input.receiptTitle(index + 1),
    })),
  });
  void localData.sync('change');
  return claimId;
}

/** Another receipt for a claim made on this phone. The photo is dropped if it cannot be queued. */
export async function addReceipt(claimId: string, file: CapturedFile, title: string) {
  try {
    await recordExpenseReceipt(context(), { claimId, file: capturedInput(file), title });
  } catch (error) {
    discardCaptured(file);
    throw error;
  }
  void localData.sync('change');
}

/** One's own recent claims as the server has them; needs signal. */
export async function fetchMyClaims() {
  const { data } = await session().client.GET('/v1/expenses', {
    params: { query: { scope: 'mine', limit: 20 } },
  });
  return data?.items ?? [];
}
