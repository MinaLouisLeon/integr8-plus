import { ApiRequestError } from '@integr8/api-client';
import {
  type DesignReference,
  matchDesignReferences,
  parseDesign,
  referenceCandidates,
  type ReferenceMatch,
  type TemplateDesign,
  unresolvedReferences,
} from '@integr8/document-render';
import { type CompiledForm, compileDefinition } from '@integr8/form-engine';
import { apiErrorMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { session } from '~/lib/session';
import { useForms } from '../forms/api';
import { Dialog } from '../forms/components/dialog';
import { say } from '../forms/model/text';

/**
 * Copying a PDF template (form builder decision 10, 1.3.0): a duplicate
 * beside it, or a copy for another form of the company.
 *
 * Copying to another form matches every question the template names in that
 * form — the same answer key where the question fits, then the same wording in
 * English or Arabic (`@integr8/document-render`, the same functions the server
 * runs) — and lists what is left, each with the questions that could stand in
 * or "take it out". Nothing is saved until every one is decided; the server
 * checks the same way and refuses otherwise.
 */

const client = () => session().client;

type Choice = string | null | undefined;

export function TemplateCopyActions({
  templateId,
  templateName,
  design,
  formId,
  form,
  dirty,
}: {
  templateId: string;
  templateName: string;
  /** The design as last saved: what a copy is made from. */
  design: unknown;
  formId: string;
  form: CompiledForm;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [repairing, setRepairing] = useState(false);

  const duplicate = useMutation({
    mutationFn: async () =>
      (
        await client().POST('/v1/document-templates/{templateId}/copy', {
          params: { path: { templateId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: {
            name: duplicateName(t('documents.templateCopy.copyName', { name: templateName })),
          },
        })
      ).data!,
    onSuccess: (copy) => {
      setNotice(t('documents.templateCopy.duplicated', { name: copy.name }));
      void queries.invalidateQueries({ queryKey: ['documents', 'templates'] });
    },
    onError: (error) => {
      // A question the template names left the form since it was saved: the
      // duplicate needs the same decisions a copy to another form does.
      if (error instanceof ApiRequestError && error.code === 'document_template_unmatched') {
        setRepairing(true);
      }
    },
  });

  return (
    <>
      <Button variant="ghost" busy={duplicate.isPending} onClick={() => duplicate.mutate()}>
        {t('documents.templateCopy.duplicate')}
      </Button>
      <Button variant="ghost" onClick={() => setCopying(true)}>
        {t('documents.templateCopy.toForm')}
      </Button>
      {notice === undefined ? null : (
        <p role="status" className="w-full text-xs text-content-muted">
          {notice}
        </p>
      )}
      {duplicate.isError && !repairing ? (
        <p role="alert" className="w-full text-xs text-danger">
          {apiErrorMessage(duplicate.error, t)}
        </p>
      ) : null}
      {dirty ? (
        <p className="w-full text-xs text-content-muted">{t('documents.templateCopy.savedOnly')}</p>
      ) : null}
      <CopyToFormDialog
        open={copying || repairing}
        sameForm={repairing}
        templateId={templateId}
        templateName={templateName}
        design={design}
        formId={formId}
        form={form}
        onClose={() => {
          setCopying(false);
          setRepairing(false);
        }}
        onDone={(message) => {
          setCopying(false);
          setRepairing(false);
          setNotice(message);
          void queries.invalidateQueries({ queryKey: ['documents', 'templates'] });
        }}
      />
    </>
  );
}

function duplicateName(name: string): string {
  return name.slice(0, 120);
}

/** What a question or section of a form is called, in the language shown. */
function labelOf(form: CompiledForm | null, id: string, locale: string): string {
  const element = form?.elements.get(id);
  if (element?.field !== undefined) {
    return say(element.field.label, locale) || id;
  }
  for (const page of form?.definition.pages ?? []) {
    for (const section of page.sections) {
      if (section.id === id) {
        return say(section.title, locale) || id;
      }
    }
  }
  return id;
}

export function CopyToFormDialog({
  open,
  sameForm,
  templateId,
  templateName,
  design,
  formId,
  form,
  onClose,
  onDone,
}: {
  open: boolean;
  /** Matching against the template's own form, for a duplicate that needs it. */
  sameForm: boolean;
  templateId: string;
  templateName: string;
  design: unknown;
  formId: string;
  form: CompiledForm;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const forms = useForms();
  const [chosenForm, setChosenForm] = useState<string | null>(null);
  const targetId = sameForm ? formId : chosenForm;
  const [name, setName] = useState<string | undefined>(undefined);
  const value = name ?? t('documents.templateCopy.copyName', { name: templateName });

  const others = (forms.data ?? []).filter(
    (item) => item.latestVersionNumber !== null && item.id !== formId,
  );

  return (
    <Dialog
      open={open}
      wide
      title={
        sameForm
          ? t('documents.templateCopy.repairTitle', { name: templateName })
          : t('documents.templateCopy.toFormTitle', { name: templateName })
      }
      onClose={() => {
        setChosenForm(null);
        setName(undefined);
        onClose();
      }}
    >
      {sameForm ? (
        <p className="text-content-muted">{t('documents.templateCopy.repairBody')}</p>
      ) : (
        <>
          <p className="text-content-muted">{t('documents.templateCopy.toFormBody')}</p>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-content">
              {t('documents.templateCopy.targetForm')}
            </span>
            <select
              value={chosenForm ?? ''}
              onChange={(event) =>
                setChosenForm(event.target.value === '' ? null : event.target.value)
              }
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
            >
              <option value="">{t('documents.templateCopy.chooseForm')}</option>
              {others.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {forms.isSuccess && others.length === 0 ? (
            <p className="text-content-muted">{t('documents.templateCopy.noForms')}</p>
          ) : null}
        </>
      )}
      <Field
        label={t('documents.templateCopy.name')}
        value={value}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
      />
      {targetId === null ? null : (
        <Matching
          key={targetId}
          templateId={templateId}
          design={design}
          source={form}
          targetFormId={targetId}
          name={value}
          onDone={onDone}
          onCancel={onClose}
        />
      )}
    </Dialog>
  );
}

function Matching({
  templateId,
  design,
  source,
  targetFormId,
  name,
  onDone,
  onCancel,
}: {
  templateId: string;
  design: unknown;
  source: CompiledForm;
  targetFormId: string;
  name: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const target = useQuery({
    queryKey: ['forms', targetFormId],
    queryFn: async () =>
      (
        await client().GET('/v1/forms/{formId}', {
          params: { path: { formId: targetFormId } },
        })
      ).data!,
  });
  const targetForm = useMemo(() => {
    const live = target.data?.live;
    if (live == null) {
      return null;
    }
    const compiled = compileDefinition(live.definition);
    return compiled.ok ? compiled.form : null;
  }, [target.data]);
  const parsed = useMemo((): TemplateDesign | null => {
    const result = parseDesign(design);
    return result.ok ? result.design : null;
  }, [design]);
  const matches = useMemo(
    (): ReferenceMatch[] =>
      parsed === null || targetForm === null
        ? []
        : matchDesignReferences(parsed, source, targetForm),
    [parsed, source, targetForm],
  );
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  const mapping = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (targetForm === null) {
      return out;
    }
    // Sections come first, so a column is checked against where its section went.
    for (const entry of matches) {
      const id = entry.reference.id;
      const section = entry.reference.section;
      const fits = referenceCandidates(
        entry.reference,
        source,
        targetForm,
        section === undefined ? undefined : (out[section] ?? null),
      );
      const choice = choices[id];
      if (choice === null || (choice !== undefined && fits.includes(choice))) {
        out[id] = choice;
      } else if (choice === undefined && entry.match !== null && fits.includes(entry.match)) {
        out[id] = entry.match;
      }
    }
    return out;
  }, [matches, choices, source, targetForm]);
  const open = unresolvedReferences(
    matches.map((entry) => entry.reference),
    mapping,
  );

  const save = useMutation({
    mutationFn: async () =>
      (
        await client().POST('/v1/document-templates/{templateId}/copy', {
          params: { path: { templateId }, header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { formId: targetFormId, name: name.trim(), answerMap: mapping },
        })
      ).data!,
    onSuccess: (copy) =>
      onDone(
        t('documents.templateCopy.copied', {
          name: copy.name,
          form: target.data?.form.title ?? '',
        }),
      ),
  });

  if (target.isPending) {
    return <LoadingState />;
  }
  if (target.isError || targetForm === null || parsed === null) {
    return <ErrorState message={t('documents.templateCopy.targetUnusable')} />;
  }

  const candidatesOf = (reference: DesignReference) =>
    referenceCandidates(
      reference,
      source,
      targetForm,
      reference.section === undefined ? undefined : (mapping[reference.section] ?? null),
    );

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-content">
        {t('documents.templateCopy.matchingTitle')}
      </h3>
      {matches.length === 0 ? (
        <p className="text-content-muted">{t('documents.templateCopy.nothingToMatch')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs text-content-muted">
              <th className="py-2 pe-3 text-start font-medium">
                {t('documents.templateCopy.inTemplate')}
              </th>
              <th className="py-2 pe-3 text-start font-medium">
                {t('documents.templateCopy.inTarget')}
              </th>
            </tr>
          </thead>
          <tbody>
            {matches.map((entry) => {
              const id = entry.reference.id;
              const chosen = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
              const unresolved = open.some((reference) => reference.id === id);
              const candidates = candidatesOf(entry.reference);
              const automatic = choices[id] === undefined && entry.match !== null;
              return (
                <tr
                  key={id}
                  className={[
                    'border-b border-border-subtle last:border-b-0',
                    unresolved ? 'bg-warning-subtle' : '',
                  ].join(' ')}
                >
                  <td className="py-2 pe-3 align-top">
                    <span dir="auto" className="font-medium text-content">
                      {labelOf(source, id, locale)}
                    </span>
                    <span dir="ltr" className="ms-2 font-mono text-xs text-content-muted">
                      {id}
                    </span>
                    {entry.reference.kind === 'section' ? (
                      <span className="block text-xs text-content-muted">
                        {t('documents.templateCopy.section')}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pe-3 align-top">
                    <select
                      aria-label={labelOf(source, id, locale)}
                      value={chosen === null ? '__remove' : (chosen ?? '')}
                      onChange={(event) => {
                        const next = event.target.value;
                        setChoices((current) => ({
                          ...current,
                          [id]: next === '' ? undefined : next === '__remove' ? null : next,
                        }));
                      }}
                      className={[
                        'w-full rounded-md border bg-surface px-2 py-1.5 text-sm text-content',
                        unresolved ? 'border-warning' : 'border-border-subtle',
                      ].join(' ')}
                    >
                      <option value="">{t('documents.templateCopy.choose')}</option>
                      {candidates.map((candidate) => (
                        <option key={candidate} value={candidate}>
                          {labelOf(targetForm, candidate, locale)} ({candidate})
                        </option>
                      ))}
                      <option value="__remove">{t('documents.templateCopy.remove')}</option>
                    </select>
                    {automatic ? (
                      <span className="mt-1 block text-xs text-content-muted">
                        {entry.by === 'key'
                          ? t('documents.templateCopy.byKey')
                          : t('documents.templateCopy.byWording')}
                      </span>
                    ) : null}
                    {candidates.length === 0 && chosen !== null ? (
                      <span className="mt-1 block text-xs text-content-muted">
                        {t('documents.templateCopy.noCandidates')}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p role="status" className="text-xs text-content-muted">
        {open.length === 0
          ? t('documents.templateCopy.allMatched')
          : t('documents.templateCopy.stillOpen', { open: String(open.length) })}
      </p>
      {save.isError ? <ErrorState message={apiErrorMessage(save.error, t)} /> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          busy={save.isPending}
          disabled={open.length > 0 || name.trim() === ''}
          onClick={() => save.mutate()}
        >
          {t('documents.templateCopy.save')}
        </Button>
      </div>
    </div>
  );
}
