/**
 * What counts as unsent work, in one place, because eviction, a download and
 * signing out all have to agree on it.
 *
 * Unsent work is a change the server has not applied (the outbox), a file it has
 * not confirmed (the upload queue), a form it has never seen, and anything from
 * before sync that has not been queued yet (P11's `drafts` and pending files).
 * None of it is evicted, replaced by a download or removed with its job.
 */

/** Jobs that unsent work belongs to. */
export const UNSENT_WORK_ORDER_IDS = `
  select work_order_id from outbox where state <> 'done' and work_order_id is not null
  union select work_order_id from uploads where state <> 'confirmed' and work_order_id is not null
  union select work_order_id from submissions where server_revision is null and work_order_id is not null
  union select work_order_id from drafts where work_order_id is not null
  union select owner_id from files where owner_kind = 'work_order' and state = 'pending_upload'`;

/** Sites with an access-notes change still to send. */
export const UNSENT_SITE_IDS = `
  select entity_id from outbox where kind = 'site.access' and state <> 'done'
  union select owner_id from files where owner_kind = 'site' and state = 'pending_upload'`;

/** Form versions an unfinished form on the phone is filled against. */
export const UNSENT_FORM_VERSION_IDS = `
  select form_version_id from submissions where status <> 'submitted' or server_revision is null
  union select form_version_id from drafts`;

/** How many pieces of work have not reached the server. */
export const UNSENT_WORK_COUNT = `
  (select count(*) from outbox where state <> 'done')
  + (select count(*) from uploads where state <> 'confirmed')
  + (select count(*) from submissions
     where server_revision is null
       and id not in (select entity_id from outbox where kind like 'submission.%'))`;
