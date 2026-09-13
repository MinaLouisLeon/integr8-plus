import type { FormDefinition } from '../definition.js';
import type { LocalizedText } from '../ids.js';

/**
 * The global template library, as shipped.
 *
 * Templates are platform content: every company can clone one, none can change
 * the original. P15 gives super admins a screen to manage them; until then the
 * library is this list, loaded into `form_templates` by the database seed, and
 * every entry is compiled by this package's tests so a broken template cannot
 * reach a customer.
 *
 * Written in English and Arabic from the start, because a template is the first
 * form many companies will ever see in this product.
 */

export interface FormTemplate {
  /** Stable, used as the database key. */
  key: string;
  title: LocalizedText;
  description: LocalizedText;
  category: 'maintenance' | 'safety' | 'completion';
  definition: FormDefinition;
}

const t = (en: string, ar: string): LocalizedText => ({ en, ar });
const option = (value: string, en: string, ar: string) => ({ value, label: t(en, ar) });

const boilerService: FormTemplate = {
  key: 'boiler_service',
  category: 'maintenance',
  title: t('Boiler service', 'صيانة الغلاية'),
  description: t(
    'Annual service with readings, a pass or fail result and the reason for any failure.',
    'صيانة سنوية مع القراءات، ونتيجة النجاح أو الرسوب، وسبب أي رسوب.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Boiler service', 'صيانة الغلاية'),
    pages: [
      {
        id: 'inspection',
        title: t('Inspection', 'الفحص'),
        sections: [
          {
            id: 'appliance',
            title: t('Appliance', 'الجهاز'),
            fields: [
              {
                id: 'serial_number',
                type: 'barcode',
                label: t('Serial number', 'الرقم التسلسلي'),
                required: true,
              },
              { id: 'installed_on', type: 'date', label: t('Installed on', 'تاريخ التركيب') },
              {
                id: 'gas_pressure',
                type: 'decimal',
                label: t('Gas pressure', 'ضغط الغاز'),
                decimalPlaces: 1,
                unit: 'mbar',
                min: '0.0',
                max: '50.0',
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
                options: [option('pass', 'Pass', 'ناجح'), option('fail', 'Fail', 'راسب')],
              },
              {
                id: 'failure_reason',
                type: 'long_text',
                label: t('Reason for failure', 'سبب الرسوب'),
                required: true,
                minLength: 10,
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'result' },
                  right: { kind: 'text', value: 'fail' },
                },
              },
              {
                id: 'photos',
                type: 'photo',
                label: t('Photos', 'الصور'),
                maxFiles: 5,
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'result' },
                  right: { kind: 'text', value: 'fail' },
                },
              },
            ],
          },
        ],
      },
      {
        id: 'sign_off',
        title: t('Sign-off', 'التوقيع'),
        sections: [
          {
            id: 'customer',
            fields: [
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

const riskAssessment: FormTemplate = {
  key: 'site_risk_assessment',
  category: 'safety',
  title: t('Site risk assessment', 'تقييم مخاطر الموقع'),
  description: t(
    'Hazards on arrival, the controls put in place, and whether work may start.',
    'المخاطر عند الوصول، والإجراءات المتخذة، وما إذا كان يمكن بدء العمل.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Site risk assessment', 'تقييم مخاطر الموقع'),
    pages: [
      {
        id: 'assessment',
        sections: [
          {
            id: 'hazards',
            title: t('Hazards', 'المخاطر'),
            fields: [
              {
                id: 'hazards_present',
                type: 'multi_select',
                label: t('Hazards present', 'المخاطر الموجودة'),
                options: [
                  option('working_at_height', 'Working at height', 'العمل على ارتفاع'),
                  option('live_electrics', 'Live electrics', 'كهرباء حية'),
                  option('confined_space', 'Confined space', 'مكان ضيق'),
                  option('asbestos', 'Suspected asbestos', 'اشتباه بوجود الأسبستوس'),
                ],
              },
              {
                id: 'isolation_confirmed',
                type: 'checkbox',
                label: t('Supply isolated and locked off', 'تم عزل مصدر التغذية وقفله'),
                required: true,
                visibleWhen: {
                  kind: 'includes',
                  field: 'hazards_present',
                  option: 'live_electrics',
                },
              },
              {
                id: 'controls',
                type: 'long_text',
                label: t('Controls in place', 'الإجراءات المتخذة'),
                visibleWhen: { kind: 'answered', field: 'hazards_present' },
              },
            ],
          },
          {
            id: 'decision',
            title: t('Decision', 'القرار'),
            fields: [
              {
                id: 'safe_to_proceed',
                type: 'yes_no',
                label: t('Safe to proceed', 'آمن للمتابعة'),
                required: true,
              },
              {
                id: 'supervisor_contacted',
                type: 'datetime',
                label: t('Supervisor contacted at', 'وقت التواصل مع المشرف'),
                required: true,
                visibleWhen: {
                  kind: 'compare',
                  operator: 'eq',
                  left: { kind: 'answer', field: 'safe_to_proceed' },
                  right: { kind: 'text', value: 'no' },
                },
              },
            ],
          },
        ],
      },
    ],
  },
};

const jobCompletion: FormTemplate = {
  key: 'job_completion',
  category: 'completion',
  title: t('Job completion', 'إتمام المهمة'),
  description: t(
    'Time on site, parts used, and the customer’s rating and signature.',
    'مدة العمل في الموقع، والقطع المستخدمة، وتقييم العميل وتوقيعه.',
  ),
  definition: {
    schemaVersion: 1,
    title: t('Job completion', 'إتمام المهمة'),
    pages: [
      {
        id: 'completion',
        sections: [
          {
            id: 'time',
            title: t('Time on site', 'مدة العمل في الموقع'),
            fields: [
              { id: 'arrived_at', type: 'time', label: t('Arrived', 'وقت الوصول'), required: true },
              {
                id: 'left_at',
                type: 'time',
                label: t('Left', 'وقت المغادرة'),
                required: true,
                rules: [
                  {
                    id: 'after_arrival',
                    assert: {
                      kind: 'compare',
                      operator: 'gt',
                      left: { kind: 'answer', field: 'left_at' },
                      right: { kind: 'answer', field: 'arrived_at' },
                    },
                    message: t(
                      'Leaving time must be after arrival.',
                      'يجب أن يكون وقت المغادرة بعد وقت الوصول.',
                    ),
                  },
                ],
              },
            ],
          },
          {
            id: 'work',
            title: t('Work', 'العمل'),
            fields: [
              {
                id: 'parts_used',
                type: 'number',
                label: t('Parts used', 'القطع المستخدمة'),
                min: 0,
                unit: 'pcs',
              },
              { id: 'notes', type: 'long_text', label: t('Notes', 'ملاحظات'), maxLength: 2000 },
            ],
          },
          {
            id: 'customer',
            title: t('Customer', 'العميل'),
            fields: [
              {
                id: 'rating',
                type: 'rating',
                label: t('How did we do?', 'ما تقييمك لنا؟'),
                scale: 5,
              },
              {
                id: 'signature',
                type: 'signature',
                label: t('Signature', 'التوقيع'),
                required: true,
              },
            ],
          },
        ],
      },
    ],
  },
};

export const FORM_TEMPLATES: readonly FormTemplate[] = Object.freeze([
  boilerService,
  riskAssessment,
  jobCompletion,
]);
