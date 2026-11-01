import type { Expression, FormDefinition, LocalizedText } from '@integr8/form-engine';

/**
 * A form that uses every question type and every kind of rule, for the
 * behaviour check (see `index.ts`): what the six library forms do not exercise,
 * this does.
 *
 * - every type in the field registry, once at least;
 * - "Show when" on a question, a section and a page;
 * - "Required only when";
 * - options that depend on another answer;
 * - custom checks with the admin's own message, and a format with its message;
 * - calculations, one of them over a repeating section's entries;
 * - a repeating section with a minimum, a title question, a check inside an
 *   entry, and checks outside it that read across its entries (count, sum,
 *   some/every).
 *
 * Written in English and Arabic, like the library.
 */

const t = (en: string, ar: string): LocalizedText => ({ en, ar });
const answer = (field: string): Expression => ({ kind: 'answer', field });
const text = (value: string): Expression => ({ kind: 'text', value });
const num = (value: string): Expression => ({ kind: 'number', value });
const eq = (left: Expression, right: Expression): Expression => ({
  kind: 'compare',
  operator: 'eq',
  left,
  right,
});
const le = (left: Expression, right: Expression): Expression => ({
  kind: 'compare',
  operator: 'le',
  left,
  right,
});
const ge = (left: Expression, right: Expression): Expression => ({
  kind: 'compare',
  operator: 'ge',
  left,
  right,
});

export const EVERYTHING_FORM: FormDefinition = {
  schemaVersion: 1,
  title: t('Everything form', 'نموذج كل شيء'),
  pages: [
    {
      id: 'basics',
      title: t('Basics', 'الأساسيات'),
      sections: [
        {
          id: 'typed',
          title: t('Typed answers', 'إجابات مكتوبة'),
          fields: [
            {
              id: 'serial',
              type: 'text',
              label: t('Serial number', 'الرقم التسلسلي'),
              help: t('Capitals and digits', 'حروف كبيرة وأرقام'),
              required: true,
              pattern: {
                source: '^[A-Z0-9]+$',
                message: t('Use capitals and digits only', 'استخدم الحروف الكبيرة والأرقام فقط'),
              },
            },
            {
              id: 'notes',
              type: 'long_text',
              label: t('Notes', 'ملاحظات'),
              maxLength: 500,
            },
            {
              id: 'asset_tag',
              type: 'barcode',
              label: t('Asset tag', 'رمز الأصل'),
            },
            {
              id: 'readings',
              type: 'number',
              label: t('Readings taken', 'عدد القراءات'),
              min: 1,
              max: 10,
              required: true,
              rules: [
                {
                  id: 'even_readings',
                  assert: le(answer('readings'), num('8')),
                  message: t('Take no more than 8 readings', 'لا تأخذ أكثر من 8 قراءات'),
                },
              ],
            },
            {
              id: 'pressure',
              type: 'decimal',
              label: t('Pressure', 'الضغط'),
              decimalPlaces: 1,
              unit: 'bar',
              min: '0.0',
              max: '6.0',
            },
            {
              id: 'pressure_doubled',
              type: 'decimal',
              label: t('Pressure, doubled', 'الضغط مضاعفًا'),
              decimalPlaces: 1,
              unit: 'bar',
              calculation: {
                kind: 'arithmetic',
                operator: 'multiply',
                left: answer('pressure'),
                right: num('2'),
              },
            },
          ],
        },
        {
          id: 'when',
          title: t('When', 'متى'),
          fields: [
            {
              id: 'visit_date',
              type: 'date',
              label: t('Visit date', 'تاريخ الزيارة'),
              earliest: '2020-01-01',
              required: true,
            },
            { id: 'arrived', type: 'time', label: t('Arrived', 'وقت الوصول') },
            { id: 'next_due', type: 'datetime', label: t('Next due', 'الموعد التالي') },
          ],
        },
      ],
    },
    {
      id: 'choices',
      title: t('Choices', 'الاختيارات'),
      sections: [
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
                { value: 'pass', label: t('Pass', 'ناجح') },
                { value: 'fail', label: t('Fail', 'راسب') },
              ],
            },
            {
              id: 'reason',
              type: 'long_text',
              label: t('Why it failed', 'سبب الرسوب'),
              visibleWhen: eq(answer('result'), text('fail')),
              requiredWhen: eq(answer('result'), text('fail')),
            },
            {
              id: 'hazards',
              type: 'multi_select',
              label: t('Hazards', 'المخاطر'),
              options: [
                { value: 'gas', label: t('Gas', 'غاز') },
                { value: 'height', label: t('Working at height', 'العمل على ارتفاع') },
              ],
              maxSelected: 2,
            },
            {
              id: 'protection',
              type: 'dropdown',
              label: t('Protection', 'الحماية'),
              options: [
                { value: 'mask', label: t('Mask', 'قناع') },
                { value: 'harness', label: t('Harness', 'حزام أمان') },
              ],
              dependsOn: { field: 'hazards', options: { mask: ['gas'], harness: ['height'] } },
              requiredWhen: { kind: 'answered', field: 'hazards' },
            },
            {
              id: 'isolated',
              type: 'checkbox',
              label: t('Supply isolated', 'تم عزل الإمداد'),
              required: true,
            },
            {
              id: 'safe',
              type: 'yes_no',
              label: t('Safe to use', 'آمن للاستخدام'),
              allowNotApplicable: true,
              required: true,
            },
            { id: 'score', type: 'rating', label: t('Condition', 'الحالة'), scale: 5 },
          ],
        },
        {
          id: 'failure_detail',
          title: t('Failure detail', 'تفاصيل الرسوب'),
          visibleWhen: eq(answer('result'), text('fail')),
          fields: [
            {
              id: 'failure_code',
              type: 'text',
              label: t('Failure code', 'رمز الرسوب'),
              required: true,
            },
          ],
        },
      ],
    },
    {
      id: 'radiators_page',
      title: t('Radiators', 'المشعات'),
      sections: [
        {
          id: 'radiators',
          title: t('Radiators', 'المشعات'),
          repeat: {
            minEntries: 1,
            maxEntries: 3,
            entryLabel: t('Radiator', 'مشع'),
            titleField: 'room',
          },
          fields: [
            { id: 'room', type: 'text', label: t('Room', 'الغرفة'), required: true },
            {
              id: 'output',
              type: 'number',
              label: t('Output', 'القدرة'),
              unit: 'W',
              min: 0,
              rules: [
                {
                  id: 'output_sane',
                  assert: le(answer('output'), num('3000')),
                  message: t(
                    'No radiator gives more than 3000 W',
                    'لا يعطي أي مشع أكثر من 3000 واط',
                  ),
                },
              ],
            },
            {
              id: 'bled',
              type: 'yes_no',
              label: t('Bled', 'تم التنفيس'),
            },
            {
              id: 'bleed_note',
              type: 'text',
              label: t('Why not bled', 'سبب عدم التنفيس'),
              visibleWhen: eq(answer('bled'), text('no')),
              requiredWhen: eq(answer('bled'), text('no')),
            },
          ],
        },
        {
          id: 'totals',
          title: t('Totals', 'الإجماليات'),
          fields: [
            {
              id: 'total_output',
              type: 'number',
              label: t('Total output', 'إجمالي القدرة'),
              unit: 'W',
              calculation: {
                kind: 'aggregate',
                operator: 'sum',
                section: 'radiators',
                field: 'output',
              },
            },
            {
              id: 'radiators_checked',
              type: 'checkbox',
              label: t('Every radiator checked', 'تم فحص كل المشعات'),
              rules: [
                {
                  id: 'enough_radiators',
                  assert: ge({ kind: 'count', section: 'radiators' }, num('2')),
                  message: t('Check at least two radiators', 'افحص مشعين على الأقل'),
                },
                {
                  id: 'all_bled',
                  assert: {
                    kind: 'every',
                    section: 'radiators',
                    condition: eq(answer('bled'), text('yes')),
                  },
                  message: t('Every radiator must be bled', 'يجب تنفيس كل المشعات'),
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'evidence',
      title: t('Evidence', 'الأدلة'),
      visibleWhen: { kind: 'answered', field: 'result' },
      sections: [
        {
          id: 'captured',
          fields: [
            { id: 'photos', type: 'photo', label: t('Photos', 'الصور'), minFiles: 1, maxFiles: 3 },
            {
              id: 'report',
              type: 'file',
              label: t('Report', 'التقرير'),
              acceptedTypes: ['application/pdf'],
            },
            { id: 'location', type: 'gps', label: t('Location', 'الموقع') },
            {
              id: 'customer_signature',
              type: 'signature',
              label: t('Customer signature', 'توقيع العميل'),
              required: true,
            },
          ],
        },
      ],
    },
  ],
};
