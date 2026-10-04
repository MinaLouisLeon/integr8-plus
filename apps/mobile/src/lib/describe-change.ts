import type { CompletionMissing } from '@integr8/core';
import type { TFunction } from '@integr8/i18n';
import { type DescribedChange, UPLOAD_FAILED } from '@integr8/offline';

/** A change as the engineer made it: "Ticked “Isolate supply” on WO-000042". */
export function describeChange(t: TFunction, change: DescribedChange): string {
  const job = change.job?.referenceLabel ?? t('mobile.change.someJob');
  const form = change.formTitle ?? t('mobile.change.someForm');
  switch (change.kind) {
    case 'work_order.transition':
      return t('mobile.change.transition', {
        job,
        state: t(`operations.state.${change.payload.to as 'complete'}`),
      });
    case 'work_order.checklist':
      return t(
        change.payload.done === true
          ? 'mobile.change.checklistDone'
          : 'mobile.change.checklistUndone',
        {
          job,
          item: change.checklistLabel ?? '',
        },
      );
    case 'work_order.comment':
      return t('mobile.change.comment', { job });
    case 'site.access':
      return t('mobile.change.access', { site: change.siteName ?? t('mobile.change.someSite') });
    case 'submission.start':
      return t('mobile.change.formStarted', { job, form });
    case 'submission.answers':
      return t('mobile.change.formAnswers', { job, form });
    case 'submission.submit':
      return t('mobile.change.formSubmitted', { job, form });
    case 'work_order.photo':
      return t(
        change.payload.stage === 'before'
          ? 'mobile.change.photoBefore'
          : 'mobile.change.photoAfter',
        { job },
      );
    case 'work_order.photo_remove':
      return t('mobile.change.photoRemoved', { job });
    case 'work_order.signoff':
      return t('mobile.change.signoff', { job });
    case 'shift.start':
      return t('mobile.change.shiftStart');
    case 'shift.end':
      return t('mobile.change.shiftEnd');
  }
}

/**
 * Why a change is waiting on the engineer, in one line. The server's refusals
 * arrive in words already; one the phone itself failed — a file that will not
 * upload — is said in the engineer's language.
 */
export function describeRefusal(t: TFunction, change: DescribedChange): string {
  if (change.lastError?.code === UPLOAD_FAILED) {
    return t('mobile.conflict.uploadFailedShort');
  }
  return change.lastError?.message ?? '';
}

/**
 * What a job still needs before it can be completed, one line each: "Submit Gas
 * safety record", "Take 2 more after photos", "Get the customer's sign-off".
 */
export function missingLines(t: TFunction, missing: CompletionMissing): string[] {
  return [
    ...missing.forms.map((form) => t('mobile.complete.missing.form', { form: form.title })),
    ...(missing.beforePhotos > 0
      ? [t('mobile.complete.missing.beforePhotos', { count: missing.beforePhotos })]
      : []),
    ...(missing.afterPhotos > 0
      ? [t('mobile.complete.missing.afterPhotos', { count: missing.afterPhotos })]
      : []),
    ...(missing.signoff ? [t('mobile.complete.missing.signoff')] : []),
  ];
}

/** An answer or a field's value, shortly: text as it is, files counted. */
export function describeValue(t: TFunction, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return t('mobile.conflict.empty');
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return t('mobile.conflict.empty');
    }
    // The entries of a repeatable section (P13b), or a list of files.
    return value.every(
      (item) => typeof item === 'object' && item !== null && 'id' in item && 'values' in item,
    )
      ? t('mobile.conflict.entries', { count: value.length })
      : t('mobile.jobSync.files', { count: value.length });
  }
  if (typeof value === 'object') {
    return 'mediaId' in value ? t('mobile.jobSync.files', { count: 1 }) : JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? t('operations.common.yes') : t('operations.common.no');
  }
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}
