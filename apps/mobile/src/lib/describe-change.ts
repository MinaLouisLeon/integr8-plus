import type { TFunction } from '@integr8/i18n';
import type { DescribedChange } from '@integr8/offline';

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
  }
}

/** An answer or a field's value, shortly: text as it is, files counted. */
export function describeValue(t: TFunction, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return t('mobile.conflict.empty');
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? t('mobile.conflict.empty')
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
