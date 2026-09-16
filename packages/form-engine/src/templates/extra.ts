import type { LocalizedText } from '../ids.js';
import type { FormTemplate } from './index.js';

/**
 * Three more templates, to reach the six P18 asks for.
 *
 * Chosen to cover the three shapes the first three do not: a **recurring
 * visit** with a checklist and a next-due date, an **emergency callout** where
 * the interesting fields are times and parts, and an **electrical certificate**
 * where the readings are numeric and a pass is a legal claim.
 *
 * Kept in their own file rather than appended to `index.ts`, which is already
 * three hundred lines: a template is content, and content that is awkward to
 * add is content nobody adds.
 */

const t = (en: string, ar: string): LocalizedText => ({ en, ar });
const option = (value: string, en: string, ar: string) => ({ value, label: t(en, ar) });

const plannedMaintenance: FormTemplate = {
  key: 'planned_maintenance_visit',
  category: 'maintenance',
  title: t('Planned maintenance visit', 'زيارة صيانة مجدولة'),
  description: t(
    'A recurring visit: what was checked, what was done, and when the next one is due.',
    'زيارة متكررة: ما تم فحصه، وما تم إنجازه، وموعد الزيارة التالية.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Planned maintenance visit', 'زيارة صيانة مجدولة'),
    pages: [
      {
        id: 'visit',
        title: t('Visit', 'الزيارة'),
        sections: [
          {
            id: 'checks',
            title: t('Checks carried out', 'الفحوصات المنفذة'),
            fields: [
              {
                id: 'asset_reference',
                type: 'text',
                label: t('Asset reference', 'مرجع الأصل'),
                required: true,
              },
              {
                id: 'checks_completed',
                type: 'multi_select',
                label: t('Checks completed', 'الفحوصات المكتملة'),
                options: [
                  option('visual', 'Visual inspection', 'فحص بصري'),
                  option('clean', 'Cleaned and cleared', 'التنظيف والإزالة'),
                  option('lubricate', 'Lubricated moving parts', 'تشحيم الأجزاء المتحركة'),
                  option('tighten', 'Connections tightened', 'إحكام التوصيلات'),
                  option('test', 'Function tested', 'اختبار التشغيل'),
                ],
              },
              {
                id: 'condition',
                type: 'radio',
                label: t('Overall condition', 'الحالة العامة'),
                required: true,
                options: [
                  option('good', 'Good', 'جيدة'),
                  option('fair', 'Fair — monitor', 'مقبولة — تحتاج متابعة'),
                  option('poor', 'Poor — action needed', 'ضعيفة — تحتاج إجراء'),
                ],
              },
              {
                id: 'action_needed',
                type: 'long_text',
                label: t('What needs doing', 'ما الذي يجب عمله'),
                required: true,
                minLength: 10,
                // Asked only when the answer above says something is wrong, so
                // a routine visit is three taps and a signature.
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'condition' },
                  right: { kind: 'text', value: 'poor' },
                },
              },
            ],
          },
          {
            id: 'next',
            title: t('Next visit', 'الزيارة التالية'),
            fields: [
              {
                id: 'next_due',
                type: 'date',
                label: t('Next visit due', 'موعد الزيارة التالية'),
                required: true,
              },
              {
                id: 'engineer_signature',
                type: 'signature',
                label: t('Engineer signature', 'توقيع الفني'),
                required: true,
              },
            ],
          },
        ],
      },
    ],
  },
};

const emergencyCallout: FormTemplate = {
  key: 'emergency_callout',
  category: 'completion',
  title: t('Emergency callout', 'استدعاء طارئ'),
  description: t(
    'An unplanned visit: what was reported, what was found, what was done, and whether it is now safe.',
    'زيارة غير مجدولة: ما تم الإبلاغ عنه، وما تم اكتشافه، وما تم عمله، وهل أصبح آمناً الآن.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Emergency callout', 'استدعاء طارئ'),
    pages: [
      {
        id: 'callout',
        title: t('Callout', 'الاستدعاء'),
        sections: [
          {
            id: 'reported',
            title: t('What was reported', 'ما تم الإبلاغ عنه'),
            fields: [
              {
                id: 'reported_fault',
                type: 'long_text',
                label: t('Reported fault', 'العطل المبلغ عنه'),
                required: true,
              },
              {
                id: 'arrived_at',
                type: 'time',
                label: t('Arrived on site', 'وقت الوصول للموقع'),
                required: true,
              },
            ],
          },
          {
            id: 'found',
            title: t('What was found', 'ما تم اكتشافه'),
            fields: [
              {
                id: 'actual_fault',
                type: 'long_text',
                label: t('Actual fault', 'العطل الفعلي'),
                required: true,
              },
              {
                id: 'photos',
                type: 'photo',
                label: t('Photos of the fault', 'صور العطل'),
                maxFiles: 6,
              },
              {
                id: 'parts_used',
                type: 'long_text',
                label: t('Parts used', 'القطع المستخدمة'),
              },
            ],
          },
          {
            id: 'outcome',
            title: t('Outcome', 'النتيجة'),
            fields: [
              {
                id: 'resolution',
                type: 'radio',
                label: t('Outcome', 'النتيجة'),
                required: true,
                options: [
                  option('fixed', 'Fixed on this visit', 'تم الإصلاح في هذه الزيارة'),
                  option(
                    'made_safe',
                    'Made safe — return visit needed',
                    'تم التأمين — يلزم زيارة أخرى',
                  ),
                  option('isolated', 'Isolated — out of use', 'تم العزل — خارج الخدمة'),
                ],
              },
              {
                id: 'safe_to_use',
                type: 'radio',
                label: t('Safe to use now?', 'هل هو آمن للاستخدام الآن؟'),
                required: true,
                options: [option('yes', 'Yes', 'نعم'), option('no', 'No', 'لا')],
              },
              {
                id: 'left_at',
                type: 'time',
                label: t('Left site', 'وقت مغادرة الموقع'),
                required: true,
              },
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
  },
};

const electricalCertificate: FormTemplate = {
  key: 'electrical_installation_check',
  category: 'safety',
  title: t('Electrical installation check', 'فحص التركيبات الكهربائية'),
  description: t(
    'Circuit readings with a pass or fail against each, and an overall assessment.',
    'قراءات الدوائر مع نتيجة النجاح أو الرسوب لكل منها، وتقييم عام.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Electrical installation check', 'فحص التركيبات الكهربائية'),
    pages: [
      {
        id: 'readings',
        title: t('Readings', 'القراءات'),
        sections: [
          {
            id: 'supply',
            title: t('Supply', 'التغذية'),
            fields: [
              {
                id: 'supply_voltage',
                type: 'decimal',
                label: t('Supply voltage', 'جهد التغذية'),
                decimalPlaces: 1,
                unit: 'V',
                min: '0.0',
                max: '500.0',
                required: true,
              },
              {
                id: 'earth_loop_impedance',
                type: 'decimal',
                label: t('Earth loop impedance', 'ممانعة حلقة التأريض'),
                decimalPlaces: 2,
                unit: 'Ω',
                min: '0.00',
                max: '100.00',
                required: true,
              },
              {
                id: 'rcd_trip_time',
                type: 'number',
                label: t('RCD trip time', 'زمن فصل قاطع التسرب'),
                unit: 'ms',
                min: 0,
                max: 1000,
                required: true,
              },
            ],
          },
          {
            id: 'assessment',
            title: t('Assessment', 'التقييم'),
            fields: [
              {
                id: 'outcome',
                type: 'radio',
                label: t('Overall assessment', 'التقييم العام'),
                required: true,
                options: [
                  option('satisfactory', 'Satisfactory', 'مُرضٍ'),
                  option('unsatisfactory', 'Unsatisfactory', 'غير مُرضٍ'),
                ],
              },
              {
                id: 'observations',
                type: 'long_text',
                label: t('Observations', 'الملاحظات'),
                required: true,
                minLength: 10,
                // An unsatisfactory result with no observations is a
                // certificate nobody can act on.
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'outcome' },
                  right: { kind: 'text', value: 'unsatisfactory' },
                },
              },
              {
                id: 'next_inspection',
                type: 'date',
                label: t('Next inspection due', 'موعد الفحص التالي'),
                required: true,
              },
              {
                id: 'engineer_signature',
                type: 'signature',
                label: t('Engineer signature', 'توقيع الفني'),
                required: true,
              },
            ],
          },
        ],
      },
    ],
  },
};

export const EXTRA_TEMPLATES: readonly FormTemplate[] = Object.freeze([
  plannedMaintenance,
  emergencyCallout,
  electricalCertificate,
]);
