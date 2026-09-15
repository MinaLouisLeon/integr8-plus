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

// ---------------------------------------------------------------------------
// Sync (P12)
// ---------------------------------------------------------------------------

type JsonBody<T> = T extends { requestBody: { content: { 'application/json': infer Body } } }
  ? Body
  : never;

export type PullPage = Ok<paths['/v1/sync/pull']['get']>;
export type SyncSubmission = PullPage['submissions'][number];
export type PushRequest = JsonBody<paths['/v1/sync/push']['post']>;
export type PushMutation = PushRequest['mutations'][number];
export type MutationKind = PushMutation['kind'];
export type PushResponse = Ok<paths['/v1/sync/push']['post']>;
export type PushResult = PushResponse['results'][number];
export type SyncConflict = Extract<PushResult, { outcome: 'conflict' }>['conflict'];
export type SyncReport = JsonBody<paths['/v1/sync/reports']['post']>['reports'][number];
export type PreparedUpload = Ok<paths['/v1/media/{mediaId}']['put']>;
export type PartLinks = Ok<paths['/v1/media/{mediaId}/parts']['post']>;
export type ArrivedParts = Ok<paths['/v1/media/{mediaId}/parts']['get']>;
export type AccessValues = Extract<PushMutation, { kind: 'site.access' }>['payload']['changes'];
