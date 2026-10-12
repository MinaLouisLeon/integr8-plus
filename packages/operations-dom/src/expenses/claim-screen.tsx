import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';
import { type ExpenseClaimDetail, type ExpenseReceipt, keys, useOperations } from '../api.js';
import { Fact } from '../hr/hr-parts.js';
import { Amount, AppLink } from '../ledger/ledger-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  ClaimStatusBadge,
  errorCode,
  ExpenseFailure,
  RECEIPT_ACCEPT,
  useExpenseAccess,
  useReceipts,
} from './expense-parts.js';

type DialogKind = 'withdraw' | 'approve' | 'reject' | 'pay';

/**
 * One expense claim (ADR-0010): what was spent, by whom and on what, where it
 * is — submitted, decided, paid back — with who did each and when, and its
 * receipts. What this person may do with it comes from the server: the
 * claimant withdraws it while it waits, somebody else who approves claims
 * approves or rejects it, and an approved claim is paid back directly or by
 * the next pay run.
 */
export function ExpenseClaimScreen({ claimId }: { claimId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const access = useExpenseAccess();
  const [dialog, setDialog] = useState<DialogKind | null>(null);

  const detail = useQuery({
    queryKey: keys.expenseClaim(claimId),
    queryFn: async () =>
      (await client.GET('/v1/expenses/{claimId}', { params: { path: { claimId } } })).data!,
  });
  const settle = async (next: ExpenseClaimDetail) => {
    setDialog(null);
    queries.setQueryData(keys.expenseClaim(next.id), next);
    await queries.invalidateQueries({ queryKey: ['expenses', 'claims'] });
  };
  const refresh = () => void queries.invalidateQueries({ queryKey: ['expenses'] });

  // Back to one's own claims, or to everybody's for a claim somebody else made.
  const theirs =
    detail.data !== undefined &&
    access.userId !== null &&
    detail.data.claimant.id !== access.userId;
  const back =
    theirs && access.approve ? (
      <BackLink to={paths.expenseClaims} label={t('expenses.claim.backToAll')} />
    ) : (
      <BackLink to={paths.myExpenseClaims} label={t('expenses.claim.backToMine')} />
    );

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <ExpenseFailure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const claim = detail.data;
  const date = (value: string) => formatCalendarDate(value, { locale });
  const { can } = claim;

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
            <span dir="ltr">{claim.reference}</span>
            <ClaimStatusBadge status={claim.status} />
          </h1>
          <p className="text-sm text-content-muted">
            {t('expenses.claim.by', { name: claim.claimant.name })}
          </p>
        </div>
        {can.withdraw || can.decide || can.pay ? (
          <div className="flex flex-wrap gap-2">
            {can.decide ? (
              <>
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => setDialog('approve')}
                >
                  {t('expenses.approve.action')}
                </button>
                <button
                  type="button"
                  className={buttonClass.danger}
                  onClick={() => setDialog('reject')}
                >
                  {t('expenses.reject.action')}
                </button>
              </>
            ) : null}
            {can.pay ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setDialog('pay')}
              >
                {t('expenses.pay.action')}
              </button>
            ) : null}
            {can.withdraw ? (
              <button
                type="button"
                className={buttonClass.danger}
                onClick={() => setDialog('withdraw')}
              >
                {t('expenses.withdraw.action')}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {claim.claimant.id === access.userId && claim.status === 'submitted' && !can.decide ? (
        <p className="text-sm text-content-muted">{t('expenses.claim.waitingNote')}</p>
      ) : null}

      <section aria-labelledby="claim-what" className={cardClass}>
        <h2 id="claim-what" className="text-base font-semibold text-content">
          {t('expenses.claim.what')}
        </h2>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('expenses.field.amount')}>
            <Amount value={claim.amount} currency={claim.currency} strong />
          </Fact>
          <Fact label={t('expenses.field.category')}>
            <span dir="auto">{claim.category.name}</span>
          </Fact>
          <Fact label={t('expenses.field.spentOn')}>{date(claim.spentOn)}</Fact>
          <Fact label={t('expenses.field.claimant')}>
            <span dir="auto">{claim.claimant.name}</span>
          </Fact>
          <Fact label={t('expenses.field.workOrder')}>
            {claim.workOrder === null ? (
              <span className="text-content-muted">{t('expenses.claim.noWorkOrder')}</span>
            ) : (
              <AppLink to={paths.workOrder(claim.workOrder.id)} ltr>
                {claim.workOrder.reference}
              </AppLink>
            )}
          </Fact>
          {claim.settleVia === null ? null : (
            <Fact label={t('expenses.field.settleVia')}>
              {t(`expenses.settleVia.${claim.settleVia}`)}
            </Fact>
          )}
          <Fact label={t('expenses.field.description')} wide>
            <span dir="auto" className="whitespace-pre-line">
              {claim.description}
            </span>
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="claim-history" className={cardClass}>
        <h2 id="claim-history" className="text-base font-semibold text-content">
          {t('expenses.claim.history')}
        </h2>
        <Timeline claim={claim} />
      </section>

      <Receipts claim={claim} onChanged={refresh} />

      {dialog === 'withdraw' ? (
        <WithdrawDialog claim={claim} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'approve' ? (
        <ApproveDialog
          claim={claim}
          payroll={access.payroll}
          onClose={() => setDialog(null)}
          onDone={settle}
        />
      ) : null}
      {dialog === 'reject' ? (
        <RejectDialog claim={claim} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
      {dialog === 'pay' ? (
        <PayDialog claim={claim} onClose={() => setDialog(null)} onDone={settle} />
      ) : null}
    </div>
  );
}

/** Submitted, then decided or withdrawn, then paid back: each step with who and when. */
function Timeline({ claim }: { claim: ExpenseClaimDetail }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const when = (value: string) => formatDateTime(value, { locale });
  const steps: { key: string; title: string; detail?: ReactNode; at: string | null }[] = [
    {
      key: 'submitted',
      title: t('expenses.timeline.submitted', { name: claim.claimant.name }),
      at: claim.submittedAt,
    },
  ];
  if (claim.status === 'withdrawn') {
    steps.push({
      key: 'withdrawn',
      title: t('expenses.timeline.withdrawn', { name: claim.claimant.name }),
      at: null,
    });
  }
  if (claim.decidedAt !== null && claim.status !== 'withdrawn') {
    const by = claim.decidedBy?.name ?? '';
    if (claim.status === 'rejected') {
      steps.push({
        key: 'rejected',
        title: t('expenses.timeline.rejected', { name: by }),
        detail:
          claim.rejectReason === null ? undefined : (
            <span dir="auto">{t('expenses.timeline.reason', { reason: claim.rejectReason })}</span>
          ),
        at: claim.decidedAt,
      });
    } else {
      steps.push({
        key: 'approved',
        title: t('expenses.timeline.approved', { name: by }),
        ...(claim.settleVia === null
          ? {}
          : { detail: t(`expenses.timeline.settle.${claim.settleVia}`) }),
        at: claim.decidedAt,
      });
    }
  }
  if (claim.status === 'paid') {
    const reference =
      claim.paymentReference === null
        ? null
        : t('expenses.timeline.paymentReference', { reference: claim.paymentReference });
    steps.push({
      key: 'paid',
      title:
        claim.paidVia === 'payroll'
          ? t('expenses.timeline.paidPayroll')
          : t('expenses.timeline.paid', {
              name: claim.paidBy?.name ?? '',
              via: t(`expenses.paidVia.${claim.paidVia ?? 'cash'}`),
            }),
      ...(reference === null ? {} : { detail: reference }),
      at: claim.paidAt,
    });
  } else if (claim.status === 'approved') {
    steps.push({
      key: 'toPay',
      title:
        claim.settleVia === 'payroll'
          ? t('expenses.timeline.awaitingPayroll')
          : t('expenses.timeline.awaitingPayment'),
      at: null,
    });
  } else if (claim.status === 'submitted') {
    steps.push({ key: 'toDecide', title: t('expenses.timeline.awaitingDecision'), at: null });
  }

  return (
    <ol className="flex flex-col gap-3 border-s border-border-subtle ps-4 text-sm">
      {steps.map((step) => (
        <li key={step.key} className="flex flex-col gap-0.5">
          <span className={step.at === null ? 'text-content-muted' : 'text-content'}>
            {step.title}
          </span>
          {step.detail === undefined ? null : (
            <span className="text-content-muted">{step.detail}</span>
          )}
          {step.at === null ? null : (
            <time dateTime={step.at} className="text-xs text-content-muted">
              {when(step.at)}
            </time>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The claim's receipts: opened in a new tab, and added or taken off while that is allowed. */
function Receipts({ claim, onChanged }: { claim: ExpenseClaimDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const receipts = useReceipts();
  const fileId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [openError, setOpenError] = useState<unknown>(null);

  const add = useMutation({
    mutationFn: async () => {
      for (const file of files) {
        await receipts.attach(claim.id, file);
      }
    },
    onSuccess: () => {
      setFiles([]);
      onChanged();
    },
    // Some may have arrived before one failed: show what the claim has now.
    onError: onChanged,
  });
  const remove = useMutation({
    mutationFn: async (receipt: ExpenseReceipt) => {
      await client.DELETE('/v1/attachments/{attachmentId}', {
        params: { path: { attachmentId: receipt.id } },
      });
    },
    onSuccess: onChanged,
  });

  return (
    <section aria-labelledby="claim-receipts" className={cardClass}>
      <h2 id="claim-receipts" className="text-base font-semibold text-content">
        {t('expenses.receipts.title')}
      </h2>
      {claim.receipts.length === 0 ? (
        <p className="text-sm text-content-muted">{t('expenses.receipts.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {claim.receipts.map((receipt) => (
            <li key={receipt.id} className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                dir="auto"
                className="text-start text-accent underline-offset-4 hover:underline"
                onClick={() => {
                  setOpenError(null);
                  receipts.open(receipt).catch(setOpenError);
                }}
              >
                {receipt.title}
              </button>
              <span className="text-xs text-content-muted">
                {t('expenses.receipts.addedBy', { name: receipt.addedBy.name })}
              </span>
              {claim.can.attach ? (
                <button
                  type="button"
                  className={buttonClass.ghost}
                  aria-label={t('expenses.receipts.removeLabel', { title: receipt.title })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(receipt)}
                >
                  {t('expenses.receipts.remove')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {openError === null ? null : <ExpenseFailure error={openError} />}
      {remove.isError ? <ExpenseFailure error={remove.error} /> : null}

      {claim.can.attach ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (files.length > 0) {
              add.mutate();
            }
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={fileId} className="text-sm font-medium text-content">
              {t('expenses.receipts.choose')}
            </label>
            <input
              id={fileId}
              type="file"
              multiple
              accept={RECEIPT_ACCEPT}
              className="text-sm text-content"
              onChange={(event) => setFiles([...(event.target.files ?? [])])}
            />
          </div>
          <button
            type="submit"
            className={buttonClass.secondary}
            disabled={files.length === 0 || add.isPending}
          >
            {add.isPending ? t('expenses.receipts.adding') : t('expenses.receipts.add')}
          </button>
        </form>
      ) : null}
      {add.isError ? <ExpenseFailure error={add.error} /> : null}
    </section>
  );
}

/** A refusal with a way to reload, when somebody else moved the claim first. */
function DialogFailure({ error, onReload }: { error: unknown; onReload: () => void }) {
  const { t } = useTranslation();
  const code = errorCode(error);
  if (code === 'version_conflict' || code === 'not_waiting' || code === 'not_approved') {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
      >
        <p>{t(`expenses.errors.${code}`)}</p>
        <button type="button" className={buttonClass.secondary} onClick={onReload}>
          {t('expenses.claim.reload')}
        </button>
      </div>
    );
  }
  return <ExpenseFailure error={error} />;
}

function useReload(claimId: string, onClose: () => void) {
  const queries = useQueryClient();
  return () => {
    onClose();
    void queries.invalidateQueries({ queryKey: ['expenses'] });
    void queries.invalidateQueries({ queryKey: keys.expenseClaim(claimId) });
  };
}

function WithdrawDialog({
  claim,
  onClose,
  onDone,
}: {
  claim: ExpenseClaimDetail;
  onClose: () => void;
  onDone: (next: ExpenseClaimDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const reload = useReload(claim.id, onClose);
  const withdraw = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses/{claimId}/withdraw', {
          params: { path: { claimId: claim.id } },
          body: { expectedVersion: claim.version },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('expenses.withdraw.title', { reference: claim.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('expenses.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.danger}
            disabled={withdraw.isPending}
            onClick={() => withdraw.mutate()}
          >
            {withdraw.isPending ? t('expenses.withdraw.pending') : t('expenses.withdraw.action')}
          </button>
        </>
      }
    >
      <p>{t('expenses.withdraw.intro')}</p>
      {withdraw.isError ? <DialogFailure error={withdraw.error} onReload={reload} /> : null}
    </Dialog>
  );
}

function ApproveDialog({
  claim,
  payroll,
  onClose,
  onDone,
}: {
  claim: ExpenseClaimDetail;
  payroll: boolean;
  onClose: () => void;
  onDone: (next: ExpenseClaimDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const reload = useReload(claim.id, onClose);
  const [settleVia, setSettleVia] = useState<'direct' | 'payroll'>('direct');
  const idPrefix = useId();
  const approve = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses/{claimId}/approve', {
          params: { path: { claimId: claim.id } },
          body: { expectedVersion: claim.version, settleVia },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('expenses.approve.title', { reference: claim.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('expenses.cancel')}
          </button>
          <button
            type="submit"
            form="expense-approve"
            className={buttonClass.primary}
            disabled={approve.isPending}
          >
            {approve.isPending ? t('expenses.approve.pending') : t('expenses.approve.action')}
          </button>
        </>
      }
    >
      <form
        id="expense-approve"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          approve.mutate();
        }}
      >
        <p>
          {t('expenses.approve.intro', { name: claim.claimant.name })}{' '}
          <Amount value={claim.amount} currency={claim.currency} strong />
        </p>
        {payroll ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-content">
              {t('expenses.approve.settleVia')}
            </legend>
            {(['direct', 'payroll'] as const).map((option) => (
              <div key={option} className="flex items-start gap-2 text-sm text-content">
                <input
                  id={`${idPrefix}-${option}`}
                  type="radio"
                  name="settleVia"
                  value={option}
                  checked={settleVia === option}
                  aria-describedby={`${idPrefix}-${option}-hint`}
                  onChange={() => setSettleVia(option)}
                  className="mt-1"
                />
                <div className="flex flex-col">
                  <label htmlFor={`${idPrefix}-${option}`}>
                    {t(`expenses.settleVia.${option}`)}
                  </label>
                  <span id={`${idPrefix}-${option}-hint`} className="text-xs text-content-muted">
                    {t(`expenses.approve.${option}Hint`, { name: claim.claimant.name })}
                  </span>
                </div>
              </div>
            ))}
          </fieldset>
        ) : (
          <p className="text-sm text-content-muted">{t('expenses.approve.directOnly')}</p>
        )}
        {approve.isError ? <DialogFailure error={approve.error} onReload={reload} /> : null}
      </form>
    </Dialog>
  );
}

function RejectDialog({
  claim,
  onClose,
  onDone,
}: {
  claim: ExpenseClaimDetail;
  onClose: () => void;
  onDone: (next: ExpenseClaimDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const reload = useReload(claim.id, onClose);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const problem = reason.trim() === '' ? t('expenses.reject.reasonRequired') : null;
  const reject = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses/{claimId}/reject', {
          params: { path: { claimId: claim.id } },
          body: { expectedVersion: claim.version, reason: reason.trim() },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('expenses.reject.title', { reference: claim.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('expenses.cancel')}
          </button>
          <button
            type="submit"
            form="expense-reject"
            className={buttonClass.danger}
            disabled={reject.isPending}
          >
            {reject.isPending ? t('expenses.reject.pending') : t('expenses.reject.action')}
          </button>
        </>
      }
    >
      <form
        id="expense-reject"
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (problem === null) {
            reject.mutate();
          }
        }}
      >
        <p>{t('expenses.reject.intro', { name: claim.claimant.name })}</p>
        <Field
          label={t('expenses.reject.reason')}
          hint={tried && problem !== null ? problem : t('expenses.reject.reasonHint')}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={3}
              dir="auto"
              required
              maxLength={1000}
              aria-describedby={describedBy}
              aria-invalid={tried && problem !== null}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {reject.isError ? <DialogFailure error={reject.error} onReload={reload} /> : null}
      </form>
    </Dialog>
  );
}

function PayDialog({
  claim,
  onClose,
  onDone,
}: {
  claim: ExpenseClaimDetail;
  onClose: () => void;
  onDone: (next: ExpenseClaimDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const reload = useReload(claim.id, onClose);
  const [via, setVia] = useState<'cash' | 'bank_transfer'>('bank_transfer');
  const [reference, setReference] = useState('');
  const pay = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/expenses/{claimId}/pay', {
          params: { path: { claimId: claim.id } },
          body: {
            expectedVersion: claim.version,
            via,
            ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
          },
        })
      ).data!,
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t('expenses.pay.title', { reference: claim.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('expenses.cancel')}
          </button>
          <button
            type="submit"
            form="expense-pay"
            className={buttonClass.primary}
            disabled={pay.isPending}
          >
            {pay.isPending ? t('expenses.pay.pending') : t('expenses.pay.confirm')}
          </button>
        </>
      }
    >
      <form
        id="expense-pay"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          pay.mutate();
        }}
      >
        <p>
          {t('expenses.pay.intro', { name: claim.claimant.name })}{' '}
          <Amount value={claim.amount} currency={claim.currency} strong />
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-content">{t('expenses.pay.via')}</legend>
          {(['bank_transfer', 'cash'] as const).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-content">
              <input
                type="radio"
                name="paidVia"
                value={option}
                checked={via === option}
                onChange={() => setVia(option)}
              />
              {t(`expenses.paidVia.${option}`)}
            </label>
          ))}
        </fieldset>
        <Field label={t('expenses.pay.reference')} hint={t('expenses.pay.referenceHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              dir="auto"
              maxLength={200}
              aria-describedby={describedBy}
              className={inputClass}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          )}
        </Field>
        {pay.isError ? <DialogFailure error={pay.error} onReload={reload} /> : null}
      </form>
    </Dialog>
  );
}
