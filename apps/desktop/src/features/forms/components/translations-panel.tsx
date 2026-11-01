import {
  collectTexts,
  type FormDefinition,
  lacksLanguage,
  setText,
  type TextLocation,
  withLanguage,
} from '@integr8/form-engine';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { useMemo, useState } from 'react';
import { Button } from '~/components/ui';
import type { EditorAction } from '../model/editor';
import { nameOf } from './canvas';
import { FORM_LANGUAGES, type FormLanguage } from './bilingual-text-input';

/**
 * Every text of the draft in one table, English beside Arabic.
 *
 * The settings panel shows one question's texts at a time; translating a whole
 * form there means clicking every question. Here each row is one text — a
 * page title, a question, its help, one option, a check's message — grouped by
 * page and section, edited in place. Each change is an ordinary edit of the
 * draft, so it is saved, undone and redone like any other.
 *
 * The texts are found by `collectTexts` (`@integr8/form-engine`), the same walk
 * the publish check uses to count texts with no Arabic, so the two always agree
 * and a kind of text added to forms later appears here by itself.
 */

interface Group {
  key: string;
  heading: string | undefined;
  sections: { key: string; heading: string | undefined; rows: TextLocation[] }[];
}

export function TranslationsPanel({
  definition,
  locale,
  readOnly,
  dispatch,
  onShow,
  initiallyOnlyMissing = false,
}: {
  definition: FormDefinition;
  locale: string;
  readOnly: boolean;
  dispatch: (action: EditorAction) => void;
  onShow: (elementId: string) => void;
  initiallyOnlyMissing?: boolean;
}) {
  const { t } = useTranslation();
  const texts = useMemo(() => collectTexts(definition), [definition]);
  const missing = texts.filter((text) => lacksLanguage(text.text, 'ar')).length;
  // The rows chosen when the filter was turned on stay put while they are filled
  // in, so a row does not vanish under the cursor at the first Arabic letter.
  const [pinned, setPinned] = useState<ReadonlySet<string> | undefined>(() =>
    initiallyOnlyMissing ? missingPaths(texts) : undefined,
  );
  const shown = pinned === undefined ? texts : texts.filter((text) => pinned.has(text.pathText));
  const groups = useMemo(
    () => groupTexts(definition, shown, locale, t),
    [definition, shown, locale, t],
  );

  const change = (text: TextLocation, language: FormLanguage, value: string) => {
    dispatch({
      type: 'edit',
      apply: (current) => {
        // Read again from the current draft: another edit may have landed since this render.
        const now = collectTexts(current).find((candidate) => candidate.pathText === text.pathText);
        if (now === undefined) {
          return current;
        }
        const next = withLanguage(now.text, language, value);
        return setText(current, now.path, next ?? (now.optional ? undefined : {}));
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6 text-start">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-prose flex-col gap-1">
          <h2 className="text-xl font-semibold text-content">{t('forms.translations.title')}</h2>
          <p className="text-sm text-content-muted">{t('forms.translations.intro')}</p>
          <p role="status" className="text-sm font-medium text-content">
            {missing === 0
              ? t('forms.translations.allTranslated')
              : t('forms.translations.missingCount', { count: missing })}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={pinned !== undefined}
            onChange={(event) => setPinned(event.target.checked ? missingPaths(texts) : undefined)}
          />
          {t('forms.translations.onlyMissing')}
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-content-muted">{t('forms.translations.nothingMissing')}</p>
      ) : (
        <fieldset disabled={readOnly} className="min-w-0">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-content-muted">
                <th scope="col" className="w-[28%] px-2 py-2 text-start font-semibold">
                  {t('forms.translations.where')}
                </th>
                {FORM_LANGUAGES.map((language) => (
                  <th key={language} scope="col" className="px-2 py-2 text-start font-semibold">
                    {t(`forms.bilingual.${language}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                {group.heading === undefined ? null : (
                  <tr className="bg-surface-muted">
                    <th
                      colSpan={3}
                      scope="colgroup"
                      className="px-2 py-2 text-start text-sm font-semibold text-content"
                    >
                      {group.heading}
                    </th>
                  </tr>
                )}
                {group.sections.map((section) => [
                  section.heading === undefined ? null : (
                    <tr key={`${section.key}-heading`}>
                      <th
                        colSpan={3}
                        scope="colgroup"
                        className="px-2 pb-1 pt-3 text-start text-xs font-semibold text-content-muted"
                      >
                        {section.heading}
                      </th>
                    </tr>
                  ),
                  ...section.rows.map((text) => (
                    <Row
                      key={text.pathText}
                      definition={definition}
                      text={text}
                      locale={locale}
                      done={pinned !== undefined && !lacksLanguage(text.text, 'ar')}
                      onChange={(language, value) => change(text, language, value)}
                      onShow={onShow}
                    />
                  )),
                ])}
              </tbody>
            ))}
          </table>
        </fieldset>
      )}
    </div>
  );
}

function Row({
  definition,
  text,
  locale,
  done,
  onChange,
  onShow,
}: {
  definition: FormDefinition;
  text: TextLocation;
  locale: string;
  done: boolean;
  onChange: (language: FormLanguage, value: string) => void;
  onShow: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  const what = describe(text, t);
  // A question's or section's own name is the text itself; anything else says whose it is.
  const owner =
    text.element === undefined || isOwnName(text)
      ? undefined
      : nameOf(definition, text.element, locale, t);
  const long =
    text.property === 'help' || Object.values(text.text).some((value) => value.length > 80);

  return (
    <tr className="border-b border-border-subtle align-top">
      <th scope="row" className="px-2 py-2 text-start font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-content">
            {what}
            {done ? (
              <span className="ms-2 text-xs font-normal text-success">
                {t('forms.translations.done')}
              </span>
            ) : null}
          </span>
          {owner === undefined ? null : (
            <span className="truncate text-xs text-content-muted">{owner}</span>
          )}
          {text.element === undefined ? null : (
            <span>
              <Button variant="ghost" onClick={() => onShow(text.element!)}>
                {t('forms.changes.show')}
              </Button>
            </span>
          )}
        </span>
      </th>
      {FORM_LANGUAGES.map((language) => {
        const missing = language === 'ar' && lacksLanguage(text.text, 'ar');
        const common = {
          'aria-label': `${what}${owner === undefined ? '' : ` · ${owner}`} · ${t(`forms.bilingual.${language}`)}`,
          dir: language === 'ar' ? ('rtl' as const) : ('ltr' as const),
          lang: language,
          maxLength: 2_000,
          value: text.text[language] ?? '',
          placeholder: missing ? t('forms.bilingual.missingArabic') : undefined,
          className: [
            'w-full rounded-md border bg-surface px-2 py-1.5 text-start text-sm text-content',
            missing ? 'border-warning' : 'border-border-subtle',
          ].join(' '),
        };
        return (
          <td key={language} className="px-2 py-2">
            {long ? (
              <textarea
                {...common}
                rows={2}
                onChange={(event) => onChange(language, event.target.value)}
              />
            ) : (
              <input
                {...common}
                type="text"
                onChange={(event) => onChange(language, event.target.value)}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

/** What a text is, in words: "Question", "Help text", "Option · pass", "Check message · check_1". */
function describe(text: TextLocation, t: TFunction): string {
  const key = PROPERTY_KEYS[text.property];
  if (key === undefined) {
    return t('forms.translations.property.other');
  }
  if (text.property === 'title') {
    return t(`forms.translations.property.${TITLE_KEYS[text.elementKind]}`);
  }
  const words = t(`forms.translations.property.${key}`);
  return text.detail === undefined ? words : `${words} · ${text.detail}`;
}

function isOwnName(text: TextLocation): boolean {
  return (
    (text.elementKind === 'field' && text.property === 'label') ||
    ((text.elementKind === 'page' || text.elementKind === 'section') && text.property === 'title')
  );
}

type TextKind =
  | 'title'
  | 'label'
  | 'help'
  | 'description'
  | 'option'
  | 'ruleMessage'
  | 'patternMessage'
  | 'entryLabel';

const PROPERTY_KEYS: Readonly<Record<string, TextKind>> = {
  title: 'title',
  label: 'label',
  help: 'help',
  description: 'description',
  'options.label': 'option',
  'rules.message': 'ruleMessage',
  'pattern.message': 'patternMessage',
  'repeat.entryLabel': 'entryLabel',
};

const TITLE_KEYS = {
  form: 'formTitle',
  page: 'pageTitle',
  section: 'sectionTitle',
  field: 'title',
} as const;

function missingPaths(texts: readonly TextLocation[]): ReadonlySet<string> {
  return new Set(
    texts.filter((text) => lacksLanguage(text.text, 'ar')).map((text) => text.pathText),
  );
}

/** Rows by page, then by section; the form's own title first, on its own. */
function groupTexts(
  definition: FormDefinition,
  texts: readonly TextLocation[],
  locale: string,
  t: TFunction,
): Group[] {
  const groups: Group[] = [];
  for (const text of texts) {
    const pageKey = text.page ?? '';
    let group = groups.at(-1);
    if (group?.key !== pageKey) {
      group = {
        key: pageKey,
        heading:
          text.page === undefined
            ? undefined
            : t('forms.translations.page', { name: nameOf(definition, text.page, locale, t) }),
        sections: [],
      };
      groups.push(group);
    }
    const sectionKey = `${pageKey}/${text.section ?? ''}`;
    let section = group.sections.at(-1);
    if (section?.key !== sectionKey) {
      section = {
        key: sectionKey,
        heading:
          text.section === undefined
            ? undefined
            : t('forms.translations.section', {
                name: nameOf(definition, text.section, locale, t),
              }),
        rows: [],
      };
      group.sections.push(section);
    }
    section.rows.push(text);
  }
  return groups;
}
