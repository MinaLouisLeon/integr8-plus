import {
  DEFAULT_FOOTER,
  DOCUMENT_FONT_KEYS,
  type DocumentField,
  type DocumentFontKey,
  type HeaderFooterSlot,
  type HeaderFooterSpec,
  type TemplateDesign,
  type TemplateStyle,
} from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useId } from 'react';
import { Button } from '~/components/ui';
import type { ChangeKind } from './block-editor';
import {
  CheckInput,
  ImageUpload,
  LocalizedInputs,
  NumberInput,
  QuestionInput,
  SelectInput,
  TextInput,
} from './designer-inputs';
import { moved, newField, questions } from './designer-model';

/**
 * The designer's settings for the whole template: the page (size, margins,
 * backgrounds), the header and footer (1.3.0 decision 6), the style (decision
 * 9) and the document fields.
 */

type Change = (design: TemplateDesign, kind?: ChangeKind) => void;

export function PageEditor({ design, onChange }: { design: TemplateDesign; onChange: Change }) {
  const { t } = useTranslation();
  const page = design.page;
  const setPage = (next: Partial<TemplateDesign['page']>, kind: ChangeKind = 'step') =>
    onChange({ ...design, page: { ...page, ...next } }, kind);
  const margin = (side: 'top' | 'bottom' | 'start' | 'end') => (
    <NumberInput
      label={t(`documents.designer.page.${side}`)}
      value={page.margins[side]}
      min={0}
      max={60}
      onChange={(value) => setPage({ margins: { ...page.margins, [side]: value ?? 0 } }, 'typing')}
    />
  );
  const firstMode =
    page.firstPage === null ? 'same' : page.firstPage.background === null ? 'plain' : 'own';
  const backgroundHint =
    page.orientation === 'landscape'
      ? t('documents.pdfBuilder.page.backgroundLandscape')
      : t('documents.pdfBuilder.page.backgroundPortrait');
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <SelectInput
          label={t('documents.pdfBuilder.page.orientation')}
          value={page.orientation}
          options={[
            { value: 'portrait', label: t('documents.pdfBuilder.page.portrait') },
            { value: 'landscape', label: t('documents.pdfBuilder.page.landscape') },
          ]}
          onChange={(orientation) => setPage({ orientation })}
        />
        <SelectInput
          label={t('documents.designer.page.language')}
          value={page.language ?? 'company'}
          options={[
            { value: 'company', label: t('documents.designer.page.languageCompany') },
            { value: 'en', label: t('documents.designer.page.english') },
            { value: 'ar', label: t('documents.designer.page.arabic') },
          ]}
          onChange={(value) => setPage({ language: value === 'company' ? null : value })}
        />
        <NumberInput
          label={t('documents.designer.page.fontSize')}
          value={page.fontSize}
          min={7}
          max={16}
          step={0.5}
          onChange={(value) => setPage({ fontSize: value ?? 10 }, 'typing')}
        />
      </div>
      <span className="text-xs font-medium text-content-muted">
        {t('documents.designer.page.margins')}
      </span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {margin('top')}
        {margin('bottom')}
        {margin('start')}
        {margin('end')}
      </div>
      <ImageUpload
        label={t('documents.designer.page.background')}
        hint={backgroundHint}
        fileId={page.background?.fileId ?? null}
        onChange={(fileId) => setPage({ background: fileId === null ? null : { fileId } })}
      />
      <SelectInput
        label={t('documents.designer.page.firstPage')}
        value={firstMode}
        options={[
          { value: 'same', label: t('documents.designer.page.firstSame') },
          { value: 'plain', label: t('documents.designer.page.firstPlain') },
          { value: 'own', label: t('documents.designer.page.firstOwn') },
        ]}
        onChange={(mode) =>
          setPage({
            firstPage:
              mode === 'same'
                ? null
                : {
                    background: mode === 'plain' ? null : (page.firstPage?.background ?? null),
                    topMargin: page.firstPage?.topMargin ?? null,
                  },
          })
        }
      />
      {page.firstPage === null ? null : (
        <>
          {firstMode === 'own' || page.firstPage.background !== null ? (
            <ImageUpload
              label={t('documents.designer.page.firstBackground')}
              hint={backgroundHint}
              fileId={page.firstPage.background?.fileId ?? null}
              onChange={(fileId) =>
                setPage({
                  firstPage: {
                    topMargin: page.firstPage?.topMargin ?? null,
                    background: fileId === null ? null : { fileId },
                  },
                })
              }
            />
          ) : null}
          <NumberInput
            label={t('documents.designer.page.firstTop')}
            hint={t('documents.designer.page.firstTopHint')}
            value={page.firstPage.topMargin}
            min={0}
            max={120}
            onChange={(topMargin) =>
              setPage(
                { firstPage: { background: page.firstPage?.background ?? null, topMargin } },
                'typing',
              )
            }
          />
        </>
      )}
    </div>
  );
}

type Place = 'start' | 'center' | 'end';
const PLACES: readonly Place[] = ['start', 'center', 'end'];

/** The header and the footer, each three places (1.3.0 decision 6). */
export function BandsEditor({ design, onChange }: { design: TemplateDesign; onChange: Change }) {
  const { t } = useTranslation();
  const page = design.page;
  const setBand = (which: 'header' | 'footer', band: HeaderFooterSpec | null, kind: ChangeKind) =>
    onChange(
      {
        ...design,
        page:
          which === 'header'
            ? { ...page, header: band }
            : { ...page, footer: band ?? { ...DEFAULT_FOOTER, end: null } },
      },
      kind,
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-content-muted">{t('documents.pdfBuilder.bands.intro')}</p>
      <BandEditor
        title={t('documents.pdfBuilder.bands.header')}
        band={page.header}
        onChange={(band, kind) => setBand('header', band, kind)}
      />
      <BandEditor
        title={t('documents.pdfBuilder.bands.footer')}
        band={page.footer}
        onChange={(band, kind) => setBand('footer', band, kind)}
      />
      <div className="flex flex-col gap-1 text-xs text-content-muted">
        <span>{t('documents.pdfBuilder.bands.placeholders')}</span>
        <code dir="ltr" className="flex flex-wrap gap-x-3 gap-y-1">
          {[
            '{{page.number}}',
            '{{page.count}}',
            '{{work_order.reference}}',
            '{{document.date}}',
            '{{field.<key>}}',
            '{{answer.<question>}}',
            '{{company.name}}',
          ].map((placeholder) => (
            <span key={placeholder}>{placeholder}</span>
          ))}
        </code>
      </div>
    </div>
  );
}

function BandEditor({
  title,
  band,
  onChange,
}: {
  title: string;
  band: HeaderFooterSpec | null;
  onChange: (band: HeaderFooterSpec | null, kind: ChangeKind) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const current: HeaderFooterSpec = band ?? {
    start: null,
    center: null,
    end: null,
    notOnFirstPage: false,
  };
  const setPlace = (place: Place, slot: HeaderFooterSlot | null, kind: ChangeKind = 'step') => {
    const next = { ...current, [place]: slot };
    onChange(
      next.start === null && next.center === null && next.end === null && !next.notOnFirstPage
        ? null
        : next,
      kind,
    );
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
    >
      <h4 id={titleId} className="text-sm font-semibold text-content">
        {title}
      </h4>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {PLACES.map((place) => {
          const slot = current[place];
          return (
            <div key={place} className="flex flex-col gap-2 rounded-md bg-surface-muted p-2">
              <SelectInput
                label={t(`documents.pdfBuilder.bands.places.${place}`)}
                value={slot?.kind ?? 'none'}
                options={[
                  { value: 'none', label: t('documents.pdfBuilder.bands.kinds.none') },
                  { value: 'logo', label: t('documents.pdfBuilder.bands.kinds.logo') },
                  { value: 'text', label: t('documents.pdfBuilder.bands.kinds.text') },
                  { value: 'page', label: t('documents.pdfBuilder.bands.kinds.page') },
                ]}
                onChange={(kind) =>
                  setPlace(
                    place,
                    kind === 'none'
                      ? null
                      : kind === 'logo'
                        ? { kind, height: 12 }
                        : kind === 'text'
                          ? {
                              kind,
                              text: { en: '{{company.name}}', ar: '{{company.name}}' },
                              bold: false,
                            }
                          : { kind },
                  )
                }
              />
              {slot?.kind === 'logo' ? (
                <NumberInput
                  label={t('documents.pdfBuilder.bands.logoHeight')}
                  value={slot.height}
                  min={4}
                  max={40}
                  onChange={(height) =>
                    setPlace(place, { kind: 'logo', height: height ?? 12 }, 'typing')
                  }
                />
              ) : null}
              {slot?.kind === 'text' ? (
                <>
                  <TextInput
                    label={t('documents.designer.block.textEn')}
                    value={slot.text.en ?? ''}
                    dir="ltr"
                    maxLength={500}
                    onChange={(en) =>
                      setPlace(place, { ...slot, text: withText(slot.text, 'en', en) }, 'typing')
                    }
                  />
                  <TextInput
                    label={t('documents.designer.block.textAr')}
                    value={slot.text.ar ?? ''}
                    dir="rtl"
                    maxLength={500}
                    onChange={(ar) =>
                      setPlace(place, { ...slot, text: withText(slot.text, 'ar', ar) }, 'typing')
                    }
                  />
                  <CheckInput
                    label={t('documents.designer.block.bold')}
                    checked={slot.bold}
                    onChange={(bold) => setPlace(place, { ...slot, bold })}
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <CheckInput
        label={t('documents.pdfBuilder.bands.notOnFirstPage')}
        checked={current.notOnFirstPage}
        onChange={(notOnFirstPage) =>
          onChange(
            notOnFirstPage ||
              current.start !== null ||
              current.center !== null ||
              current.end !== null
              ? { ...current, notOnFirstPage }
              : null,
            'step',
          )
        }
      />
    </section>
  );
}

function withText(text: Record<string, string>, language: 'en' | 'ar', value: string) {
  const next = { ...text };
  if (value === '') {
    delete next[language];
  } else {
    next[language] = value;
  }
  return next;
}

/** The template's style (1.3.0 decision 9). */
export function StyleEditor({
  design,
  onChange,
  companyBrandColour,
}: {
  design: TemplateDesign;
  onChange: Change;
  /** The company's accent colour, shown beside "the company's colour". */
  companyBrandColour: string | null;
}) {
  const { t } = useTranslation();
  const style = design.style;
  const setStyle = (next: Partial<TemplateStyle>, kind: ChangeKind = 'step') =>
    onChange({ ...design, style: { ...style, ...next } }, kind);
  const colourMode =
    style.brandColour === null ? 'none' : style.brandColour === 'company' ? 'company' : 'own';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-2">
        <SelectInput
          label={t('documents.pdfBuilder.style.brandColour')}
          value={colourMode}
          options={[
            {
              value: 'company',
              label: t('documents.pdfBuilder.style.brandCompany', {
                colour: companyBrandColour ?? '#2563eb',
              }),
            },
            { value: 'own', label: t('documents.pdfBuilder.style.brandOwn') },
            { value: 'none', label: t('documents.pdfBuilder.style.brandNone') },
          ]}
          onChange={(mode) =>
            setStyle({
              brandColour:
                mode === 'none'
                  ? null
                  : mode === 'company'
                    ? 'company'
                    : (companyBrandColour ?? '#2563eb'),
            })
          }
        />
        {colourMode === 'own' && style.brandColour !== null ? (
          <ColourInput
            label={t('documents.pdfBuilder.style.ownColour')}
            value={style.brandColour}
            onChange={(brandColour) => setStyle({ brandColour }, 'typing')}
          />
        ) : null}
        <SelectInput
          label={t('documents.pdfBuilder.style.font')}
          value={style.font}
          options={DOCUMENT_FONT_KEYS.map((key: DocumentFontKey) => ({
            value: key,
            label: t(`documents.pdfBuilder.style.fonts.${key}`),
          }))}
          onChange={(font) => setStyle({ font })}
        />
        <SelectInput
          label={t('documents.pdfBuilder.style.tableLines')}
          value={style.tableLines}
          options={[
            { value: 'none', label: t('documents.pdfBuilder.style.linesNone') },
            { value: 'light', label: t('documents.pdfBuilder.style.linesLight') },
            { value: 'strong', label: t('documents.pdfBuilder.style.linesStrong') },
          ]}
          onChange={(tableLines) => setStyle({ tableLines })}
        />
      </div>
      <CheckInput
        label={t('documents.pdfBuilder.style.headerShading')}
        checked={style.headerShading}
        onChange={(headerShading) => setStyle({ headerShading })}
      />
      <CheckInput
        label={t('documents.pdfBuilder.style.striped')}
        checked={style.stripedRows}
        onChange={(stripedRows) => setStyle({ stripedRows })}
      />
    </div>
  );
}

function ColourInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-content-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-12 rounded border border-border-subtle bg-surface"
        />
        <code dir="ltr" className="text-xs text-content-muted">
          {value}
        </code>
      </div>
    </div>
  );
}

export function FieldsEditor({
  design,
  form,
  locale,
  attention,
  onChange,
}: {
  design: TemplateDesign;
  form: CompiledForm;
  locale: string;
  /** Document fields naming a question the form no longer has, with what is wrong. */
  attention: ReadonlyMap<string, string>;
  onChange: Change;
}) {
  const { t } = useTranslation();
  const setFields = (fields: DocumentField[], kind: ChangeKind = 'typing') =>
    onChange({ ...design, fields }, kind);
  const update = (index: number, field: DocumentField, kind: ChangeKind = 'typing') =>
    setFields(
      design.fields.map((candidate, at) => (at === index ? field : candidate)),
      kind,
    );
  const facts = [
    'form_title',
    'submitted_date',
    'submitted_by',
    'work_order_reference',
    'asset_reference',
    'document_date',
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      {design.fields.map((field, index) => (
        <div
          key={index}
          className={[
            'flex flex-col gap-3 rounded-md border p-3',
            attention.has(field.key) ? 'border-danger' : 'border-border-subtle',
          ].join(' ')}
        >
          {attention.has(field.key) ? (
            <p className="rounded-md bg-danger-subtle px-2 py-1 text-xs text-content">
              {attention.get(field.key)}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <TextInput
              label={t('documents.designer.field.key')}
              hint={t('documents.designer.field.keyHint')}
              value={field.key}
              dir="ltr"
              maxLength={64}
              onChange={(key) => update(index, { ...field, key: key.toLowerCase() })}
            />
            <SelectInput
              label={t('documents.designer.field.lookup')}
              value={field.lookup}
              options={[
                { value: 'none', label: t('documents.designer.field.lookupNone') },
                { value: 'key', label: t('documents.designer.field.lookupKey') },
                { value: 'confirm', label: t('documents.designer.field.lookupConfirm') },
              ]}
              onChange={(lookup) => update(index, { ...field, lookup }, 'step')}
            />
          </div>
          <LocalizedInputs
            labels={{
              en: t('documents.designer.field.labelEn'),
              ar: t('documents.designer.field.labelAr'),
            }}
            value={field.label}
            onChange={(label) => update(index, { ...field, label: label ?? {} })}
          />
          <SelectInput
            label={t('documents.designer.field.source')}
            value={field.source.kind}
            options={[
              { value: 'typed', label: t('documents.designer.field.typed') },
              { value: 'answer', label: t('documents.designer.field.answer') },
              { value: 'submission', label: t('documents.designer.field.submission') },
            ]}
            onChange={(kind) =>
              update(
                index,
                {
                  ...field,
                  source:
                    kind === 'typed'
                      ? { kind, required: false, maxLength: 100 }
                      : kind === 'answer'
                        ? { kind, fieldId: questions(form)[0]?.id ?? '' }
                        : { kind, value: 'document_date' },
                },
                'step',
              )
            }
          />
          {field.source.kind === 'typed' ? (
            <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-2">
              <CheckInput
                label={t('documents.designer.field.required')}
                checked={field.source.required}
                onChange={(required) =>
                  update(
                    index,
                    {
                      ...field,
                      source: {
                        kind: 'typed',
                        required,
                        maxLength: field.source.kind === 'typed' ? field.source.maxLength : 100,
                      },
                    },
                    'step',
                  )
                }
              />
              <NumberInput
                label={t('documents.designer.field.maxLength')}
                value={field.source.maxLength}
                min={1}
                max={500}
                onChange={(maxLength) =>
                  update(index, {
                    ...field,
                    source: {
                      kind: 'typed',
                      required: field.source.kind === 'typed' && field.source.required,
                      maxLength: maxLength ?? 100,
                    },
                  })
                }
              />
            </div>
          ) : field.source.kind === 'answer' ? (
            <QuestionInput
              label={t('documents.designer.field.answerField')}
              value={field.source.fieldId}
              questions={questions(form)}
              locale={locale}
              onChange={(fieldId) =>
                update(index, { ...field, source: { kind: 'answer', fieldId } }, 'step')
              }
            />
          ) : (
            <SelectInput
              label={t('documents.designer.field.fact')}
              value={field.source.value}
              options={facts.map((value) => ({
                value,
                label: t(`documents.designer.field.facts.${value}`),
              }))}
              onChange={(value) =>
                update(index, { ...field, source: { kind: 'submission', value } }, 'step')
              }
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={index === 0}
              aria-label={t('documents.designer.block.moveUp')}
              onClick={() => setFields(moved(design.fields, index, -1), 'step')}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              disabled={index === design.fields.length - 1}
              aria-label={t('documents.designer.block.moveDown')}
              onClick={() => setFields(moved(design.fields, index, 1), 'step')}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                setFields(
                  design.fields.filter((_field, at) => at !== index),
                  'step',
                )
              }
            >
              {t('documents.designer.field.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={design.fields.length >= 20}
          onClick={() => setFields([...design.fields, newField(design.fields)], 'step')}
        >
          {t('documents.designer.field.add')}
        </Button>
      </div>
    </div>
  );
}
