import { COVERAGE_OVERRIDE_REASON_MAX } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { keys, useOperations, type WorkOrderDetail } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, InlineError, inputClass } from '../ui.js';
import { ContractLink } from './contract-parts.js';

/**
 * Whether a contract covers this job (P27): worked out when the job was
 * created, and changed by office staff with a reason that goes into the
 * job's history. Nothing is shown for a customer that never had a contract.
 */
export function CoverageCard({ job }: { job: WorkOrderDetail }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const [overriding, setOverriding] = useState(false);
  const coverage = job.coverage;
  if (coverage === null) {
    return null;
  }
  const covered = coverage.status === 'covered';

  return (
    <section aria-labelledby="coverage-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="coverage-heading" className="text-lg font-semibold text-content">
          {t('operations.coverage.title')}
        </h2>
        {job.can.overrideCoverage && job.workOrder.state !== 'cancelled' ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setOverriding(true)}>
            {t('operations.coverage.override')}
          </button>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
            covered
              ? 'border-success bg-success-subtle text-content'
              : 'border-warning bg-warning-subtle text-content'
          }`}
        >
          {covered ? t('operations.coverage.covered') : t('operations.coverage.chargeable')}
        </span>
        {coverage.contract === null ? null : (
          <span className="text-content">
            {covered ? t('operations.coverage.byContract') : t('operations.coverage.contractNamed')}{' '}
            <ContractLink contract={coverage.contract} />{' '}
            <span dir="auto" className="text-content-muted">
              · {coverage.contract.title}
            </span>
          </span>
        )}
      </p>
      <p className="text-sm text-content">{t(`operations.coverage.reason.${coverage.reason}`)}</p>
      {coverage.overrideReason === null ? null : (
        <p className="text-sm text-content-muted">
          {t('operations.coverage.overridden', {
            when:
              coverage.overriddenAt === null
                ? ''
                : formatDateTime(coverage.overriddenAt, { locale }),
            reason: coverage.overrideReason,
          })}
        </p>
      )}
      {overriding ? <OverrideDialog job={job} onClose={() => setOverriding(false)} /> : null}
    </section>
  );
}

function OverrideDialog({ job, onClose }: { job: WorkOrderDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const current = job.coverage!;
  const [status, setStatus] = useState<'covered' | 'chargeable'>(
    current.status === 'covered' ? 'chargeable' : 'covered',
  );
  const [contractId, setContractId] = useState(current.contract?.id ?? '');
  const [reason, setReason] = useState('');

  const customerId = job.customer.id;
  const contracts = useQuery({
    queryKey: keys.contracts({ customerId }),
    queryFn: async () =>
      (await client.GET('/v1/contracts', { params: { query: { customerId } } })).data!,
  });
  const choices = (contracts.data?.items ?? []).filter(
    (contract) => contract.standing !== 'cancelled' || contract.id === contractId,
  );
  const ready = reason.trim() !== '' && (status === 'chargeable' || contractId !== '');

  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/work-orders/{workOrderId}/coverage', {
          params: { path: { workOrderId: job.workOrder.id } },
          body: {
            status,
            contractId: contractId === '' ? null : contractId,
            reason: reason.trim(),
          },
        })
      ).data!,
    onSuccess: (coverage) => {
      queryClient.setQueryData(keys.workOrder(job.workOrder.id), { ...job, coverage });
      // The history has a new line, and the lists show the new badge.
      void queryClient.invalidateQueries({ queryKey: ['work-orders'] });
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !save.isPending) {
      save.mutate();
    }
  };
  const formId = `coverage-${job.workOrder.id}`;

  return (
    <Dialog
      title={t('operations.coverage.overrideTitle', { reference: job.workOrder.referenceLabel })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={!ready || save.isPending}
            aria-busy={save.isPending}
          >
            {t('operations.coverage.overrideSave')}
          </button>
        </>
      }
    >
      <p className="text-content-muted">{t('operations.coverage.overrideIntro')}</p>
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-content">
            {t('operations.coverage.status')}
          </legend>
          {(['covered', 'chargeable'] as const).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-content">
              <input
                type="radio"
                name={`${formId}-status`}
                value={option}
                checked={status === option}
                onChange={() => setStatus(option)}
              />
              {t(`operations.coverage.${option}`)}
            </label>
          ))}
        </fieldset>
        <Field
          label={t('operations.coverage.contract')}
          hint={
            status === 'covered'
              ? t('operations.coverage.contractRequired')
              : t('operations.common.optional')
          }
        >
          {(id, describedBy) => (
            <select
              id={id}
              className={inputClass}
              value={contractId}
              required={status === 'covered'}
              aria-describedby={describedBy}
              onChange={(event) => setContractId(event.target.value)}
            >
              <option value="">{t('operations.coverage.noContract')}</option>
              {choices.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {`${contract.reference} · ${contract.title} (${t(
                    `operations.contracts.standing.${contract.standing}`,
                  )})`}
                </option>
              ))}
            </select>
          )}
        </Field>
        {contracts.isError ? <InlineError onRetry={() => void contracts.refetch()} /> : null}
        <Field
          label={t('operations.coverage.reasonLabel')}
          hint={t('operations.coverage.reasonHint')}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={2}
              required
              maxLength={COVERAGE_OVERRIDE_REASON_MAX}
              className={inputClass}
              value={reason}
              aria-describedby={describedBy}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </form>
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}
