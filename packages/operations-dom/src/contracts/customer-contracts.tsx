import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, InlineError, usePermissions } from '../ui.js';
import { ContractDialog, ContractLink, ContractStandingBadge, TermText } from './contract-parts.js';

/**
 * A customer's service contracts (P27), on the customer screen: each with its
 * term and standing, cancelled ones included, and a way to add one for whoever
 * keeps contracts. Shown only to a seat that may read contracts.
 */
export function CustomerContractsSection({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const permissions = usePermissions();
  const visible = permissions.includes('contract.read');
  const [adding, setAdding] = useState(false);

  const contracts = useQuery({
    queryKey: keys.contracts({ customerId, cancelled: true }),
    queryFn: async () =>
      (
        await client.GET('/v1/contracts', {
          params: { query: { customerId, includeCancelled: 'true' } },
        })
      ).data!,
    enabled: visible,
  });

  if (!visible) {
    return null;
  }

  return (
    <section aria-labelledby="customer-contracts-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="customer-contracts-heading" className="text-lg font-semibold text-content">
          {t('operations.contracts.customerHeading')}
        </h2>
        {contracts.data?.can.manage === true ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setAdding(true)}>
            {t('operations.contracts.add')}
          </button>
        ) : null}
      </div>
      {contracts.isPending ? null : contracts.isError ? (
        <InlineError onRetry={() => void contracts.refetch()} />
      ) : contracts.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.contracts.noneForCustomer')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {contracts.data.items.map((contract) => (
            <li
              key={contract.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="flex flex-col">
                <ContractLink contract={contract}>
                  {' · '}
                  <span dir="auto">{contract.title}</span>
                </ContractLink>
                <span className="text-xs text-content-muted">
                  <TermText startsOn={contract.startsOn} endsOn={contract.endsOn} />
                </span>
              </span>
              <ContractStandingBadge standing={contract.standing} />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <ContractDialog
          customer={{ id: customerId, name: customerName }}
          renewalNoticeDays={contracts.data?.defaults.renewalNoticeDays}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            navigate(paths.contract(saved.id));
          }}
        />
      ) : null}
    </section>
  );
}
