import { useTranslation } from '@integr8/i18n';

/**
 * The PDF templates a new version of the form would leave needing attention
 * (1.3.0 decision 13), as the form builder's check lists them: each template,
 * and each of its blocks that names a question the version drops or changes.
 * Publishing still works; documents are still made; the templates are marked
 * in the designer until someone fixes them.
 */

export interface AffectedTemplate {
  templateId: string;
  name: string;
  problems: { code: string; message: string; blockId: string | null; fieldKey: string | null }[];
}

export function AffectedTemplates({ templates }: { templates: readonly AffectedTemplate[] }) {
  const { t } = useTranslation();
  if (templates.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-content">
        {t('documents.pdfBuilder.formCheck.title')}
      </h3>
      <p className="text-sm text-content-muted">{t('documents.pdfBuilder.formCheck.body')}</p>
      <ul className="flex flex-col gap-2">
        {templates.map((template) => (
          <li
            key={template.templateId}
            className="rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm"
          >
            <span className="font-medium" dir="auto">
              {template.name}
            </span>
            <ul className="mt-1 list-disc ps-5">
              {template.problems.map((problem, index) => (
                <li key={index}>
                  {problem.blockId !== null
                    ? t('documents.pdfBuilder.formCheck.block', { block: problem.blockId })
                    : problem.fieldKey !== null
                      ? t('documents.pdfBuilder.formCheck.field', { field: problem.fieldKey })
                      : null}{' '}
                  {t(`documents.pdfBuilder.attention.codes.${problem.code}`, {
                    defaultValue: problem.message,
                  })}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
