/**
 * A plan's name, in the reader's language.
 *
 * The API names plans by key — `starter`, `standard` — and a key is not a word.
 * Anything the API sends that this app does not know is shown as sent, which
 * is wrong in a way somebody will notice and fix, rather than hidden.
 */
type Translate = (
  key:
    'common.plan.trial' | 'common.plan.starter' | 'common.plan.standard' | 'common.plan.enterprise',
) => string;

export function planLabel(t: Translate, plan: string): string {
  switch (plan) {
    case 'trial':
      return t('common.plan.trial');
    case 'starter':
      return t('common.plan.starter');
    case 'standard':
      return t('common.plan.standard');
    case 'enterprise':
      return t('common.plan.enterprise');
    default:
      return plan;
  }
}
