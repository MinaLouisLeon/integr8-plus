'use client';

import { NAV_GROUPS, SWITCHABLE_NAV_SECTIONS } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';

/**
 * Which menu tabs a company sees, one switch each (0075).
 *
 * For Integr8 staff only: on the onboarding form and the company's page. The
 * company never sees these. A tab switched on whose module is off switches the
 * module on when saved, and a module with none of its tabs on is switched off;
 * the hint under each group says which module it is.
 */
export function TabPicker({
  value,
  onChange,
  disabled = false,
}: {
  /** The tabs switched on, by navigation key. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const on = new Set(value);

  const set = (keys: readonly string[], enabled: boolean) => {
    const next = new Set(on);
    for (const key of keys) {
      if (enabled) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    // Menu order, so the list sent is stable and easy to read in the audit log.
    onChange(
      SWITCHABLE_NAV_SECTIONS.filter((section) => next.has(section.key)).map(
        (section) => section.key,
      ),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => {
        const sections = SWITCHABLE_NAV_SECTIONS.filter((section) => section.group === group);
        if (sections.length === 0) {
          return null;
        }
        const keys = sections.map((section) => section.key);
        const modules = [...new Set(sections.flatMap((section) => section.feature ?? []))];
        return (
          <fieldset
            key={group}
            className="flex flex-col gap-2 rounded-md border border-border-subtle p-3"
          >
            <legend className="flex flex-wrap items-center gap-3 px-1 text-sm font-medium text-content">
              {t(`nav.group.${group}`)}
              <button
                type="button"
                disabled={disabled}
                onClick={() => set(keys, true)}
                className="text-xs font-normal text-accent underline-offset-2 hover:underline disabled:opacity-50"
              >
                {t('platform.tabs.all')}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => set(keys, false)}
                className="text-xs font-normal text-accent underline-offset-2 hover:underline disabled:opacity-50"
              >
                {t('platform.tabs.none')}
              </button>
            </legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((section) => (
                <label key={section.key} className="flex items-center gap-2 text-sm text-content">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={on.has(section.key)}
                    onChange={(event) => set([section.key], event.target.checked)}
                  />
                  <span>
                    {t(`nav.section.${section.path}`)}
                    {section.webOnly === true ? (
                      <span className="ms-1 text-xs text-content-muted">
                        {t('platform.tabs.webOnly')}
                      </span>
                    ) : section.desktopOnly === true ? (
                      <span className="ms-1 text-xs text-content-muted">
                        {t('platform.tabs.desktopOnly')}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
            {modules.length === 0 ? null : (
              <p className="text-xs text-content-muted">
                {t('platform.tabs.moduleHint', { modules: modules.join(', ') })}
              </p>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
