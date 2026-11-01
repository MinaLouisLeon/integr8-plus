import { day, type DemoContext } from '../context.js';

/**
 * Forms, submissions and PDF documents.
 *
 * Integr8 staff build the forms: two from the template library, and an
 * air-conditioning service report written here, with no photo or signature
 * questions so engineers' submissions can be completed without uploads. The
 * report is attached to the planned-maintenance job type, filled in on the
 * finished jobs, and given a PDF template; two certificates are made from it
 * (the worker renders them).
 *
 * Adds to refs:
 *   forms        { serviceReport, ... } → form id
 *   submissions  { id, status }[]   (filled by field-service.ts, added to by seedDocuments)
 */

const SERVICE_REPORT = {
  schemaVersion: 1,
  title: { en: 'Air-conditioning service report', ar: 'تقرير صيانة التكييف' },
  pages: [
    {
      id: 'service',
      title: { en: 'Service', ar: 'الصيانة' },
      sections: [
        {
          id: 'unit',
          title: { en: 'Unit', ar: 'الوحدة' },
          fields: [
            {
              id: 'unit_location',
              type: 'text',
              label: { en: 'Where is the unit?', ar: 'مكان الوحدة' },
              required: true,
            },
            {
              id: 'serial_number',
              type: 'barcode',
              label: { en: 'Serial number', ar: 'الرقم التسلسلي' },
            },
            {
              id: 'supply_temp',
              type: 'decimal',
              label: { en: 'Supply air temperature', ar: 'درجة حرارة الهواء' },
              decimalPlaces: 1,
              unit: '°C',
              min: '0.0',
              max: '40.0',
              required: true,
            },
            {
              id: 'filters_changed',
              type: 'yes_no',
              label: { en: 'Filters changed?', ar: 'هل تم تغيير الفلاتر؟' },
              required: true,
            },
          ],
        },
        {
          id: 'outcome',
          title: { en: 'Outcome', ar: 'النتيجة' },
          fields: [
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result', ar: 'النتيجة' },
              required: true,
              options: [
                { value: 'pass', label: { en: 'Working normally', ar: 'يعمل بشكل طبيعي' } },
                {
                  value: 'advisory',
                  label: { en: 'Working, needs attention soon', ar: 'يعمل ويحتاج متابعة' },
                },
                { value: 'fail', label: { en: 'Not working', ar: 'لا يعمل' } },
              ],
            },
            {
              id: 'notes',
              type: 'long_text',
              label: { en: 'Engineer notes', ar: 'ملاحظات المهندس' },
            },
            {
              id: 'next_service',
              type: 'date',
              label: { en: 'Next service due', ar: 'موعد الصيانة القادمة' },
            },
          ],
        },
      ],
    },
  ],
};

/** A version 2 design (1.3.0): a header and footer, the company's colour, the website's fonts. */
const CERTIFICATE_DESIGN = {
  schemaVersion: 2,
  page: {
    size: 'A4',
    orientation: 'portrait',
    margins: { top: 28, end: 15, bottom: 20, start: 15 },
    background: null,
    firstPage: null,
    language: 'en',
    fontSize: 10,
    header: {
      start: { kind: 'logo', height: 11 },
      center: { kind: 'text', text: { en: 'Job {{work_order.reference}}' }, bold: true },
      end: { kind: 'page' },
      notOnFirstPage: false,
    },
    footer: {
      start: { kind: 'text', text: { en: '{{company.name}}' }, bold: false },
      center: { kind: 'text', text: { en: 'Certificate {{field.certificate}}' }, bold: false },
      end: { kind: 'page' },
      notOnFirstPage: false,
    },
  },
  style: {
    brandColour: 'company',
    font: 'integr8-text',
    tableLines: 'light',
    stripedRows: true,
    headerShading: true,
  },
  fields: [
    {
      key: 'certificate',
      label: { en: 'Certificate number', ar: 'رقم الشهادة' },
      source: { kind: 'typed', required: true, maxLength: 40 },
      lookup: 'key',
    },
  ],
  blocks: [
    {
      type: 'heading',
      id: 'title',
      text: { en: 'Service certificate {{field.certificate}}' },
      level: 1,
    },
    { type: 'field', id: 'location', fieldId: 'unit_location', layout: 'inline' },
    { type: 'field', id: 'temp', fieldId: 'supply_temp', layout: 'inline' },
    { type: 'field', id: 'result', fieldId: 'result', layout: 'inline' },
    { type: 'field', id: 'notes', fieldId: 'notes', layout: 'stacked', shaded: true },
    { type: 'qr', id: 'qr', size: 30, align: 'end' },
  ],
};

const ANSWERS = [
  {
    unit_location: 'Roof, north side',
    serial_number: 'CR30RB-77812',
    supply_temp: '13.5',
    filters_changed: 'yes',
    result: 'pass',
    notes: 'Coils cleaned, refrigerant pressures normal.',
    next_service: day(90),
  },
  {
    unit_location: 'Plant room B',
    serial_number: 'TR-CL14-0091',
    supply_temp: '14.2',
    filters_changed: 'yes',
    result: 'advisory',
    notes: 'Fan belt worn; replace at next visit.',
    next_service: day(30),
  },
  {
    unit_location: 'Cold store 1 plant deck',
    serial_number: 'BZ-4FES-2040',
    supply_temp: '2.1',
    filters_changed: 'no',
    result: 'pass',
    notes: 'Compressor amps within range.',
    next_service: day(60),
  },
  {
    unit_location: 'Pool plant room',
    supply_temp: '18.0',
    filters_changed: 'yes',
    result: 'fail',
    notes: 'Unit tripping on high pressure; condenser fan motor to be replaced.',
    next_service: day(7),
  },
];

interface FormBody {
  form: { id: string };
  draft: { revision: number } | null;
}

export async function seedForms(ctx: DemoContext): Promise<void> {
  const forms: Record<string, string> = {};

  // Two forms from the library, published as they are. The library is loaded
  // by the migrate service on every deploy; a machine where that has not run
  // has none, and the seed says so by name rather than leaving two forms out
  // with only a 404 in the warnings to show for it.
  const library = await ctx.call<{ items: { key: string }[] }>(
    'staff',
    'GET',
    '/v1/form-templates',
  );
  const available = new Set(library.items.map((template) => template.key));
  for (const [key, title] of [
    ['site_risk_assessment', 'Site risk assessment'],
    ['emergency_callout', 'Emergency call-out report'],
  ] as const) {
    if (!available.has(key)) {
      ctx.warn(
        `The form template library has no "${key}", so the demo company has no "${title}" form. ` +
          (available.size === 0
            ? 'The library is empty: the migrate service loads it on each deploy (docker compose … up -d), or load it now with docker compose … run --rm migrate node node_modules/@integr8/db/dist/seed/templates-cli.js.'
            : 'This build ships a template the database lacks: restart the stack so the migrate service loads the library.'),
      );
      continue;
    }
    const cloned = await ctx.attempt<FormBody>('staff', 'POST', `/v1/form-templates/${key}/clone`, {
      title,
    });
    if (cloned?.draft != null) {
      forms[key] = cloned.form.id;
      await ctx.attempt('staff', 'POST', `/v1/forms/${cloned.form.id}/draft/publish`, {
        expectedRevision: cloned.draft.revision,
        changeNote: 'First version, from the template library',
      });
    }
  }

  // The service report, written for this company.
  const created = await ctx.call<FormBody>('staff', 'POST', '/v1/forms', {
    title: 'Air-conditioning service report',
  });
  const reportId = created.form.id;
  const opened = await ctx.call<FormBody>('staff', 'GET', `/v1/forms/${reportId}`);
  const saved = await ctx.call<{ revision: number }>(
    'staff',
    'PUT',
    `/v1/forms/${reportId}/draft`,
    {
      definition: SERVICE_REPORT,
      expectedRevision: opened.draft?.revision ?? null,
    },
  );
  await ctx.call('staff', 'POST', `/v1/forms/${reportId}/draft/publish`, {
    expectedRevision: saved.revision,
    changeNote: 'First version',
    acknowledgeBreakingChanges: false,
  });
  await ctx.attempt('staff', 'PATCH', `/v1/forms/${reportId}`, {
    fillRoles: ['owner', 'admin', 'dispatcher', 'engineer'],
  });
  forms.serviceReport = reportId;
  ctx.refs.forms = forms;

  // On the planned-maintenance job type, optional so existing jobs still close.
  const ppm = (ctx.refs.jobTypes as Record<string, string> | undefined)?.PPM;
  if (ppm !== undefined) {
    await ctx.attempt('staff', 'PATCH', `/v1/job-types/${ppm}`, {
      forms: [{ formId: reportId, required: false }],
    });
  }

  // Engineers fill it in on their jobs while working them; see field-service.ts,
  // which uses ctx.refs.forms.serviceReport and REPORT_ANSWERS.
  ctx.log(`${String(Object.keys(forms).length)} forms published`);
}

/** Answers engineers give on the service report, one per job that gets one. */
export const REPORT_ANSWERS = ANSWERS;

/**
 * Runs after the jobs: a draft report on an open job, then the PDF template
 * and two certificates from the submitted reports.
 */
export async function seedDocuments(ctx: DemoContext): Promise<void> {
  const reportId = (ctx.refs.forms as Record<string, string> | undefined)?.serviceReport;
  if (reportId === undefined) {
    ctx.log('no service report form; nothing to do');
    return;
  }
  const submissions = (ctx.refs.submissions as { id: string; status: string }[] | undefined) ?? [];

  // One left half-done, by the dispatcher, with no job.
  const started = await ctx.attempt<{ submission: { id: string; revision: number } }>(
    'dispatcher',
    'POST',
    '/v1/submissions',
    {
      formId: reportId,
    },
  );
  if (started !== undefined) {
    await ctx.attempt('dispatcher', 'PUT', `/v1/submissions/${started.submission.id}/answers`, {
      answers: { unit_location: 'Server room, level 2', supply_temp: '17.5' },
      expectedRevision: started.submission.revision,
    });
    submissions.push({ id: started.submission.id, status: 'draft' });
  }

  // A PDF template for the report, and two certificates from it.
  let documents = 0;
  const template = await ctx.attempt<{ id: string }>('staff', 'POST', '/v1/document-templates', {
    formId: reportId,
    name: 'Service certificate',
    design: CERTIFICATE_DESIGN,
  });
  if (template !== undefined) {
    for (const [index, submission] of submissions
      .filter((s) => s.status === 'submitted')
      .slice(0, 2)
      .entries()) {
      try {
        const document = await ctx.attempt<{ id: string }>(
          'owner',
          'POST',
          `/v1/submissions/${submission.id}/documents`,
          {
            templateId: template.id,
            fields: { certificate: `NDF-SC-${String(2401 + index)}` },
          },
        );
        if (document !== undefined) {
          documents += 1;
          // New documents start not shared (0067): share the first, so its QR
          // code opens, and leave the second to show the switch.
          if (index === 0) {
            await ctx.attempt('owner', 'POST', `/v1/documents/${document.id}/share`, {
              shareable: true,
            });
          }
        }
      } catch (error) {
        // 503 when the server cannot make PDFs (no WEB_APP_URL, say): the rest stands.
        ctx.warn(
          `PDF certificate not made: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
  }

  ctx.log(
    `${String(submissions.length)} submissions (${String(submissions.filter((s) => s.status === 'submitted').length)} submitted), ${String(documents)} PDF documents queued`,
  );
}
