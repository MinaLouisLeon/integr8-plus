import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useShellChrome } from '~/components/shell-chrome';
import { session } from '~/lib/session';

/**
 * The top bar's title for a record screen, once the record has loaded.
 *
 * The shared screens (`@integr8/operations-dom`) load these records with these
 * same query keys and the same client, so this reads their cache rather than
 * sending a second request. Until it answers, the section's name stands.
 */

export function useWorkOrderChrome(workOrderId: string): void {
  const detail = useQuery({
    queryKey: ['work-orders', workOrderId],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/work-orders/{workOrderId}', {
        params: { path: { workOrderId } },
      });
      return data;
    },
  });
  useShellChrome({ title: detail.data?.workOrder.referenceLabel });
}

export function useCustomerChrome(customerId: string): void {
  const detail = useQuery({
    queryKey: ['customers', customerId],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/customers/{customerId}', {
        params: { path: { customerId } },
      });
      return data;
    },
  });
  useShellChrome({ title: detail.data?.customer.name });
}

/** A site is reached from its customer, so its way back goes there rather than to the list. */
export function useSiteChrome(siteId: string): void {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: ['sites', siteId],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/sites/{siteId}', {
        params: { path: { siteId } },
      });
      return data;
    },
  });
  const customer = detail.data?.customer;
  useShellChrome({
    title: detail.data?.site.name,
    backTo:
      customer === undefined
        ? undefined
        : { to: `/customers/${customer.id}`, label: t('nav.backTo', { title: customer.name }) },
  });
}
