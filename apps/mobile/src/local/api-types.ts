import type { paths } from '@integr8/api-client';

/**
 * The server's shapes the phone stores, taken from the generated contract so a
 * change to the API that the download does not handle fails the typecheck.
 */

type Ok<T> = T extends { responses: { 200: { content: { 'application/json': infer Body } } } }
  ? Body
  : never;

export type Me = Ok<paths['/v1/me']['get']>;
export type WorkOrderPage = Ok<paths['/v1/work-orders']['get']>;
export type WorkOrderSummary = WorkOrderPage['items'][number];
export type WorkOrderDetail = Ok<paths['/v1/work-orders/{workOrderId}']['get']>;
export type CustomerDetail = Ok<paths['/v1/customers/{customerId}']['get']>;
export type SiteBody = CustomerDetail['sites'][number];
export type FormDetail = Ok<paths['/v1/forms/{formId}']['get']>;
