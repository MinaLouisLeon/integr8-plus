import type { Information, LocalizedText } from '@integr8/form-engine';
import { informationText } from '@integr8/form-input';
import { useTranslation } from '@integr8/i18n';
import { say } from './text.js';

/**
 * Text that is not a question (schema version 2): an Information block among
 * the questions, and the description under a page or section title. Plain
 * text with its line breaks kept (`whitespace-pre-line`) — never markup.
 */

const STYLE_CLASS = {
  plain: 'text-content',
  tip: 'rounded-md border-s-4 border-accent bg-accent-subtle px-3 py-2 text-content',
  warning: 'rounded-md border-s-4 border-warning bg-warning-subtle px-3 py-2 text-content',
} as const;

export function InformationBlock({ item, locale }: { item: Information; locale: string }) {
  const { t } = useTranslation();
  const { heading, lines, style } = informationText(item, locale);
  return (
    <div
      role={style === 'warning' ? 'note' : undefined}
      data-information={item.id}
      data-style={style}
      className={`flex flex-col gap-1 text-sm ${STYLE_CLASS[style]}`}
    >
      {style === 'plain' ? null : <span className="sr-only">{t(`fill.information.${style}`)}</span>}
      {heading === undefined ? null : <p className="font-semibold">{heading}</p>}
      <p className="whitespace-pre-line text-content">{lines.join('\n')}</p>
    </div>
  );
}

/** A page's or section's description, under its title. Nothing when it has none. */
export function Description({
  text,
  locale,
  id,
}: {
  text: LocalizedText | undefined;
  locale: string;
  id?: string;
}) {
  const said = say(text, locale).trim();
  return said === '' ? null : (
    <p id={id} className="whitespace-pre-line text-sm text-content-muted">
      {said}
    </p>
  );
}
