import type { FormDefinition, LocalizedText } from '@integr8/form-engine';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';

/**
 * Examples for the AI to learn from (`list_examples`, `get_example`): the six
 * forms of the shipped template library exactly as companies get them, two
 * more that show what the library does not (the demo company's service report
 * and a form using every 1.3.0 addition), and PDF templates that print them.
 * Every example passes `checkFormPackage`; `examples.test.ts` keeps it so.
 */

export interface FormExample {
  key: string;
  kind: 'form';
  title: LocalizedText;
  description: string;
  definition: FormDefinition | Record<string, unknown>;
}

export interface TemplateExample {
  key: string;
  kind: 'pdf_template';
  name: string;
  description: string;
  /** The form example it prints. */
  form: string;
  design: Record<string, unknown>;
}

export type Example = FormExample | TemplateExample;

const t = (en: string, ar: string): LocalizedText => ({ en, ar });
const answer = (field: string) => ({ kind: 'answer', field });
const text = (value: string) => ({ kind: 'text', value });
const equals = (field: string, value: string) => ({
  kind: 'compare',
  operator: 'eq',
  left: answer(field),
  right: text(value),
});

/** The demo company's report (apps/api/src/demo/sections/forms.ts), with no photos or signatures. */
const SERVICE_REPORT = {
  schemaVersion: 1,
  title: t('Air-conditioning service report', 'تقرير صيانة التكييف'),
  pages: [
    {
      id: 'service',
      title: t('Service', 'الصيانة'),
      sections: [
        {
          id: 'unit',
          title: t('Unit', 'الوحدة'),
          fields: [
            {
              id: 'unit_location',
              type: 'text',
              label: t('Where is the unit?', 'مكان الوحدة'),
              required: true,
            },
            { id: 'serial_number', type: 'barcode', label: t('Serial number', 'الرقم التسلسلي') },
            {
              id: 'supply_temp',
              type: 'decimal',
              label: t('Supply air temperature', 'درجة حرارة الهواء'),
              decimalPlaces: 1,
              unit: '°C',
              min: '0.0',
              max: '40.0',
              required: true,
            },
            {
              id: 'filters_changed',
              type: 'yes_no',
              label: t('Filters changed?', 'هل تم تغيير الفلاتر؟'),
              required: true,
            },
          ],
        },
        {
          id: 'outcome',
          title: t('Outcome', 'النتيجة'),
          fields: [
            {
              id: 'result',
              type: 'radio',
              label: t('Result', 'النتيجة'),
              required: true,
              options: [
                { value: 'pass', label: t('Working normally', 'يعمل بشكل طبيعي') },
                {
                  value: 'advisory',
                  label: t('Working, needs attention soon', 'يعمل ويحتاج متابعة'),
                },
                { value: 'fail', label: t('Not working', 'لا يعمل') },
              ],
            },
            { id: 'notes', type: 'long_text', label: t('Engineer notes', 'ملاحظات المهندس') },
            {
              id: 'next_service',
              type: 'date',
              label: t('Next service due', 'موعد الصيانة القادمة'),
            },
          ],
        },
      ],
    },
  ],
};

/** Every 1.3.0 addition in one form: descriptions, Information blocks, date and number formulas. */
const COOLING_INSPECTION = {
  schemaVersion: 2,
  title: t('Cooling plant inspection', 'فحص محطة التبريد'),
  pages: [
    {
      id: 'visit',
      title: t('Visit', 'الزيارة'),
      description: t(
        'Record the visit times and the plant readings before inspecting each unit.',
        'سجّل أوقات الزيارة وقراءات المحطة قبل فحص كل وحدة.',
      ),
      sections: [
        {
          id: 'times',
          title: t('Times', 'الأوقات'),
          fields: [
            {
              id: 'isolate_first',
              type: 'information',
              style: 'warning',
              heading: t('Safety first', 'السلامة أولاً'),
              body: t(
                'Isolate the electrical supply before opening any unit casing.',
                'افصل التغذية الكهربائية قبل فتح غلاف أي وحدة.',
              ),
            },
            {
              id: 'serviced_on',
              type: 'date',
              label: t('Serviced on', 'تاريخ الصيانة'),
              required: true,
            },
            { id: 'arrived', type: 'time', label: t('Arrived', 'وقت الوصول'), required: true },
            {
              id: 'left_site',
              type: 'time',
              label: t('Left site', 'وقت المغادرة'),
              required: true,
            },
            {
              id: 'hours_on_site',
              type: 'decimal',
              decimalPlaces: 2,
              unit: 'h',
              label: t('Hours on site', 'ساعات العمل بالموقع'),
              calculation: {
                kind: 'difference',
                unit: 'hours',
                from: answer('arrived'),
                to: answer('left_site'),
              },
            },
            {
              id: 'next_service',
              type: 'date',
              label: t('Next service due', 'موعد الصيانة القادمة'),
              calculation: {
                kind: 'shift_date',
                operator: 'add',
                unit: 'months',
                date: answer('serviced_on'),
                amount: { kind: 'number', value: '6' },
              },
            },
          ],
        },
        {
          id: 'readings',
          title: t('Chilled water readings', 'قراءات المياه المبردة'),
          description: t('Three readings a minute apart.', 'ثلاث قراءات بفاصل دقيقة.'),
          fields: [
            {
              id: 'temp_1',
              type: 'decimal',
              decimalPlaces: 1,
              unit: '°C',
              label: t('Reading 1', 'القراءة 1'),
              required: true,
            },
            {
              id: 'temp_2',
              type: 'decimal',
              decimalPlaces: 1,
              unit: '°C',
              label: t('Reading 2', 'القراءة 2'),
              required: true,
            },
            {
              id: 'temp_3',
              type: 'decimal',
              decimalPlaces: 1,
              unit: '°C',
              label: t('Reading 3', 'القراءة 3'),
              required: true,
            },
            {
              id: 'average_temp',
              type: 'decimal',
              decimalPlaces: 1,
              unit: '°C',
              label: t('Average', 'المتوسط'),
              calculation: {
                kind: 'round',
                places: 1,
                operand: {
                  kind: 'statistic',
                  operator: 'average',
                  operands: [answer('temp_1'), answer('temp_2'), answer('temp_3')],
                },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'inspection',
      title: t('Units', 'الوحدات'),
      sections: [
        {
          id: 'units',
          title: t('Units inspected', 'الوحدات التي تم فحصها'),
          repeat: {
            minEntries: 1,
            maxEntries: 30,
            entryLabel: t('Unit', 'وحدة'),
            titleField: 'unit_name',
          },
          fields: [
            {
              id: 'unit_name',
              type: 'text',
              label: t('Unit name or tag', 'اسم الوحدة أو رقمها'),
              required: true,
            },
            {
              id: 'unit_type',
              type: 'dropdown',
              label: t('Type', 'النوع'),
              options: [
                { value: 'split', label: t('Split unit', 'وحدة سبليت') },
                { value: 'package', label: t('Package unit', 'وحدة باكدج') },
                { value: 'chiller', label: t('Chiller', 'تشيلر') },
              ],
            },
            {
              id: 'unit_ok',
              type: 'yes_no',
              label: t('Working correctly?', 'هل تعمل بشكل صحيح؟'),
              required: true,
            },
            {
              id: 'unit_fault',
              type: 'long_text',
              label: t('Fault found', 'العطل الموجود'),
              visibleWhen: equals('unit_ok', 'no'),
              requiredWhen: equals('unit_ok', 'no'),
            },
          ],
        },
        {
          id: 'outcome',
          title: t('Outcome', 'النتيجة'),
          fields: [
            {
              id: 'units_count',
              type: 'number',
              label: t('Units inspected', 'عدد الوحدات'),
              calculation: { kind: 'count', section: 'units' },
            },
            {
              id: 'faults_tip',
              type: 'information',
              style: 'tip',
              body: t(
                'At least one unit has a fault: describe the follow-up work below.',
                'توجد وحدة واحدة على الأقل بها عطل: صِف أعمال المتابعة أدناه.',
              ),
              visibleWhen: { kind: 'some', section: 'units', condition: equals('unit_ok', 'no') },
            },
            {
              id: 'overall',
              type: 'radio',
              label: t('Overall result', 'النتيجة العامة'),
              required: true,
              options: [
                { value: 'pass', label: t('Pass', 'ناجح') },
                { value: 'advisory', label: t('Pass with advisories', 'ناجح مع ملاحظات') },
                { value: 'fail', label: t('Fail', 'راسب') },
              ],
            },
            {
              id: 'follow_up',
              type: 'long_text',
              label: t('Follow-up work', 'أعمال المتابعة'),
              requiredWhen: { kind: 'some', section: 'units', condition: equals('unit_ok', 'no') },
            },
            {
              id: 'technician_signature',
              type: 'signature',
              label: t('Technician signature', 'توقيع الفني'),
              required: true,
            },
          ],
        },
      ],
    },
  ],
};

/** The demo company's certificate (a design version 2: header, footer, brand colour, website font). */
const CERTIFICATE_DESIGN = {
  schemaVersion: 2,
  page: {
    size: 'A4',
    orientation: 'portrait',
    margins: { top: 28, end: 15, bottom: 20, start: 15 },
    background: null,
    firstPage: null,
    language: null,
    fontSize: 10,
    header: {
      start: { kind: 'logo', height: 11 },
      center: {
        kind: 'text',
        text: t('Job {{work_order.reference}}', 'أمر العمل {{work_order.reference}}'),
        bold: true,
      },
      end: { kind: 'page' },
      notOnFirstPage: false,
    },
    footer: {
      start: { kind: 'text', text: t('{{company.name}}', '{{company.name}}'), bold: false },
      center: {
        kind: 'text',
        text: t('Certificate {{field.certificate}}', 'شهادة رقم {{field.certificate}}'),
        bold: false,
      },
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
      label: t('Certificate number', 'رقم الشهادة'),
      source: { kind: 'typed', required: true, maxLength: 40 },
      lookup: 'key',
    },
  ],
  blocks: [
    {
      type: 'heading',
      id: 'title',
      text: t('Service certificate {{field.certificate}}', 'شهادة صيانة رقم {{field.certificate}}'),
      level: 1,
    },
    { type: 'field', id: 'location', fieldId: 'unit_location', layout: 'inline' },
    { type: 'field', id: 'temp', fieldId: 'supply_temp', layout: 'inline' },
    { type: 'field', id: 'result', fieldId: 'result', layout: 'inline' },
    { type: 'field', id: 'notes', fieldId: 'notes', layout: 'stacked', shaded: true },
    { type: 'qr', id: 'qr', size: 30, align: 'end' },
  ],
};

/** A report for the library's boiler service: tables, ticked options, photos and the signature. */
const BOILER_REPORT_DESIGN = {
  schemaVersion: 2,
  page: {
    size: 'A4',
    orientation: 'portrait',
    margins: { top: 30, end: 15, bottom: 22, start: 15 },
    background: null,
    firstPage: null,
    language: null,
    fontSize: 10,
    header: {
      start: { kind: 'logo', height: 12 },
      center: null,
      end: {
        kind: 'text',
        text: t(
          'Boiler service report\n{{document.date}}',
          'تقرير صيانة الغلاية\n{{document.date}}',
        ),
        bold: true,
      },
      notOnFirstPage: false,
    },
    footer: {
      start: { kind: 'text', text: t('{{company.name}}', '{{company.name}}'), bold: false },
      center: null,
      end: { kind: 'page' },
      notOnFirstPage: false,
    },
  },
  style: {
    brandColour: 'company',
    font: 'noto-sans',
    tableLines: 'light',
    stripedRows: false,
    headerShading: true,
  },
  fields: [],
  blocks: [
    { type: 'heading', id: 'title', text: t('Boiler service', 'صيانة الغلاية'), level: 1 },
    {
      type: 'text',
      id: 'intro',
      text: t(
        'Serviced on {{submission.date}} by {{submission.submitted_by}} for job {{work_order.reference}}.',
        'تمت الصيانة بتاريخ {{submission.date}} بواسطة {{submission.submitted_by}} لأمر العمل {{work_order.reference}}.',
      ),
      colour: 'grey',
    },
    {
      type: 'fields_table',
      id: 'appliance',
      title: t('Appliance', 'الجهاز'),
      rows: [
        { fieldId: 'serial_number' },
        { fieldId: 'installed_on' },
        { fieldId: 'gas_pressure' },
      ],
    },
    { type: 'divider', id: 'line' },
    { type: 'options', id: 'result', fieldId: 'result', columns: 2 },
    { type: 'field', id: 'reason', fieldId: 'failure_reason', layout: 'stacked', colour: 'red' },
    { type: 'image', id: 'photos', source: { kind: 'answer', fieldId: 'photos' }, width: 50 },
    {
      type: 'row',
      id: 'sign_row',
      columns: [
        {
          width: 2,
          blocks: [
            {
              type: 'text',
              id: 'declaration',
              text: t(
                'The customer confirms the work above was carried out.',
                'يؤكد العميل أن الأعمال المذكورة أعلاه قد تمت.',
              ),
              size: 'small',
            },
          ],
        },
        {
          width: 1,
          blocks: [
            {
              type: 'image',
              id: 'signature',
              source: { kind: 'answer', fieldId: 'customer_signature' },
              width: 55,
              caption: t('Customer signature', 'توقيع العميل'),
            },
          ],
        },
      ],
    },
  ],
};

/** Landscape, for a wide table of repeating entries, with an Information block printed. */
const COOLING_LANDSCAPE_DESIGN = {
  schemaVersion: 2,
  page: {
    size: 'A4',
    orientation: 'landscape',
    margins: { top: 24, end: 12, bottom: 18, start: 12 },
    background: null,
    firstPage: null,
    language: null,
    fontSize: 9,
    header: {
      start: { kind: 'logo', height: 10 },
      center: { kind: 'text', text: t('Cooling plant inspection', 'فحص محطة التبريد'), bold: true },
      end: {
        kind: 'text',
        text: t('{{answer.serviced_on}}', '{{answer.serviced_on}}'),
        bold: false,
      },
      notOnFirstPage: false,
    },
    footer: { start: null, center: { kind: 'page' }, end: null, notOnFirstPage: false },
  },
  style: {
    brandColour: '#0f766e',
    font: 'integr8-display',
    tableLines: 'strong',
    stripedRows: true,
    headerShading: true,
  },
  fields: [],
  blocks: [
    {
      type: 'row',
      id: 'summary',
      columns: [
        {
          width: 1,
          blocks: [
            { type: 'field', id: 'serviced_on', fieldId: 'serviced_on' },
            { type: 'field', id: 'next_service', fieldId: 'next_service' },
          ],
        },
        {
          width: 1,
          blocks: [
            { type: 'field', id: 'hours', fieldId: 'hours_on_site' },
            { type: 'field', id: 'average', fieldId: 'average_temp' },
          ],
        },
        { width: 1, blocks: [{ type: 'options', id: 'overall', fieldId: 'overall', columns: 1 }] },
      ],
    },
    { type: 'information', id: 'safety', informationId: 'isolate_first' },
    {
      type: 'repeat_table',
      id: 'units',
      sectionId: 'units',
      title: t('Units inspected', 'الوحدات التي تم فحصها'),
      numbered: true,
      columns: [
        { fieldId: 'unit_name', width: 25 },
        { fieldId: 'unit_type', width: 15 },
        { fieldId: 'unit_ok', header: t('OK?', 'سليمة؟'), width: 10 },
        { fieldId: 'unit_fault' },
      ],
    },
    { type: 'field', id: 'follow_up', fieldId: 'follow_up', layout: 'stacked', shaded: true },
    {
      type: 'image',
      id: 'signature',
      source: { kind: 'answer', fieldId: 'technician_signature' },
      width: 50,
      align: 'end',
      caption: t('Technician', 'الفني'),
    },
  ],
};

const LIBRARY: FormExample[] = FORM_TEMPLATES.map((template) => ({
  key: template.key,
  kind: 'form',
  title: template.title,
  description: `Library form (${template.category}): ${template.description.en ?? ''}`,
  definition: template.definition,
}));

export const EXAMPLES: readonly Example[] = [
  ...LIBRARY,
  {
    key: 'ac_service_report',
    kind: 'form',
    title: SERVICE_REPORT.title,
    description:
      "The demo company's air-conditioning service report: choices, a ranged decimal with a unit, yes/no.",
    definition: SERVICE_REPORT,
  },
  {
    key: 'cooling_plant_inspection',
    kind: 'form',
    title: COOLING_INSPECTION.title,
    description:
      'Every 1.3.0 addition (schema version 2): page and section descriptions, Information blocks (warning, and a tip shown by a rule), time difference, date + months, average of readings, a repeating section with count/some.',
    definition: COOLING_INSPECTION,
  },
  {
    key: 'ac_service_certificate',
    kind: 'pdf_template',
    name: 'Service certificate',
    description:
      'Portrait certificate: logo/text/page header, footer with a typed certificate number, website font, shaded notes, QR code.',
    form: 'ac_service_report',
    design: CERTIFICATE_DESIGN,
  },
  {
    key: 'boiler_service_report',
    kind: 'pdf_template',
    name: 'Boiler service report',
    description:
      'Portrait report for the library boiler form: placeholders, a fields table, ticked options, a red failure reason, photos, and a two-column signature row.',
    form: 'boiler_service',
    design: BOILER_REPORT_DESIGN,
  },
  {
    key: 'cooling_plant_landscape',
    kind: 'pdf_template',
    name: 'Inspection sheet (landscape)',
    description:
      'Landscape sheet: a three-column summary row, a printed Information block, a numbered repeat table of the units, own brand colour, display font, strong table lines.',
    form: 'cooling_plant_inspection',
    design: COOLING_LANDSCAPE_DESIGN,
  },
];

export function findExample(key: string): Example | undefined {
  return EXAMPLES.find((example) => example.key === key);
}
