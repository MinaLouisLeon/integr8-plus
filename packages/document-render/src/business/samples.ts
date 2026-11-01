import type {
  BusinessDocumentData,
  BusinessDocumentKind,
  BusinessLocale,
  InvoiceDocumentData,
  JobReportData,
  PurchaseOrderDocumentData,
  QuoteDocumentData,
} from './model.js';

/**
 * One realistic record of each kind, in English and in Arabic, for the
 * layouts' tests and for the sample PDFs in docs/screenshots
 * (`apps/api/src/documents/business-samples-cli.ts`). Nothing a company sees
 * is made from it.
 */

const ISSUER = {
  en: {
    name: 'Nile Cooling Services',
    address: '14 Gamal Abdel Nasser Street\nNew Cairo, Cairo 11835',
    taxReference: '512-334-889',
  },
  ar: {
    name: 'النيل لخدمات التبريد',
    address: '١٤ شارع جمال عبد الناصر\nالقاهرة الجديدة، القاهرة ١١٨٣٥',
    taxReference: '512-334-889',
  },
} as const;

const FOOTER = {
  en: 'Nile Cooling Services · Commercial register 88412 · +20 2 2614 5500 · service@nilecooling.example',
  ar: 'النيل لخدمات التبريد · سجل تجاري ٨٨٤١٢ · ‎+20 2 2614 5500 · service@nilecooling.example',
} as const;

const CUSTOMER = {
  en: {
    name: 'Horizon Business Park',
    address: {
      line1: 'Building B2, 90th Street',
      line2: 'Fifth Settlement',
      city: 'New Cairo',
      postcode: '11835',
    },
    contact: 'Mona Adel',
  },
  ar: {
    name: 'مجمع الأفق للأعمال',
    address: {
      line1: 'مبنى B2، شارع التسعين',
      line2: 'التجمع الخامس',
      city: 'القاهرة الجديدة',
      postcode: '11835',
    },
    contact: 'منى عادل',
  },
} as const;

function lines(locale: BusinessLocale) {
  const ar = locale === 'ar';
  return [
    {
      description: ar
        ? 'صيانة دورية لوحدة تكييف مركزية (٦٠ طن)'
        : 'Quarterly service, 60-ton rooftop unit',
      quantity: '2',
      unit: 'each',
      unitPrice: '4500.00',
      discountBp: 1000,
      taxRateBp: 1400,
      total: '9234.00',
    },
    {
      description: ar ? 'فلتر هواء G4 مقاس ٥٩٢×٥٩٢' : 'G4 air filter 592×592',
      quantity: '24',
      unit: 'each',
      unitPrice: '185.00',
      discountBp: 0,
      taxRateBp: 1400,
      total: '5061.60',
    },
    {
      description: ar ? 'غاز تبريد R410A' : 'R410A refrigerant',
      quantity: '11.5',
      unit: 'kg',
      unitPrice: '420.00',
      discountBp: 0,
      taxRateBp: 1400,
      total: '5506.20',
    },
    {
      description: ar ? 'ساعات عمل فني' : 'Technician labour',
      quantity: '6',
      unit: 'hour',
      unitPrice: '350.00',
      discountBp: 0,
      taxRateBp: 1400,
      total: '2394.00',
    },
  ];
}

const TOTALS = {
  gross: '20670.00',
  discount: '900.00',
  net: '19770.00',
  tax: '2767.80',
  total: '22537.80',
};

export function sampleQuote(locale: BusinessLocale): QuoteDocumentData {
  const ar = locale === 'ar';
  return {
    kind: 'quote',
    reference: 'QT-000042-R2',
    issuer: ISSUER[locale],
    footer: FOOTER[locale],
    title: ar ? 'عقد الصيانة الربع سنوية – المبنى B2' : 'Quarterly maintenance – Building B2',
    status: 'issued',
    issuedAt: '2026-10-28T09:30:00Z',
    validUntil: '2026-11-27',
    customerName: CUSTOMER[locale].name,
    customerAddress: CUSTOMER[locale].address,
    contactName: CUSTOMER[locale].contact,
    introduction: ar
      ? 'شكرًا لطلبكم. يغطي هذا العرض الصيانة الربع سنوية لوحدتي التكييف على سطح المبنى B2، بما في ذلك الفلاتر وإعادة شحن الغاز.'
      : 'Thank you for your enquiry. This quote covers the quarterly service of the two rooftop units on Building B2, including filters and a refrigerant top-up.',
    terms: ar
      ? 'الدفع خلال ٣٠ يومًا من الفاتورة. الأسعار سارية لمدة ٣٠ يومًا. تُنفذ الأعمال خلال ساعات العمل الرسمية.'
      : 'Payment within 30 days of invoice. Prices are valid for 30 days. Work is carried out during normal working hours.',
    currencyCode: 'EGP',
    lines: lines(locale),
    totals: TOTALS,
    answer: null,
  };
}

export function sampleInvoice(locale: BusinessLocale): InvoiceDocumentData {
  const ar = locale === 'ar';
  return {
    kind: 'invoice',
    reference: 'INV-000317',
    issuer: ISSUER[locale],
    footer: FOOTER[locale],
    status: 'partially_paid',
    issueDate: '2026-10-30',
    dueDate: '2026-11-29',
    customerName: CUSTOMER[locale].name,
    customerAddress: CUSTOMER[locale].address,
    contactName: CUSTOMER[locale].contact,
    notes: ar
      ? 'أعمال الصيانة الربع سنوية بحسب أمر البيع SO-000088.'
      : 'Quarterly service as agreed on sales order SO-000088.',
    paymentInstructions: ar
      ? 'تحويل بنكي إلى البنك الأهلي المصري\nرقم الحساب: 0123 4567 8901 2345\nيُرجى ذكر رقم الفاتورة.'
      : 'Bank transfer to National Bank of Egypt\nAccount: 0123 4567 8901 2345\nPlease quote the invoice number.',
    currencyCode: 'EGP',
    lines: lines(locale),
    totals: TOTALS,
    amounts: { credited: '500.00', allocated: '10000.00', balance: '12037.80' },
    creditNotes: [{ reference: 'CN-000021', issueDate: '2026-10-31', total: '500.00' }],
    payments: [{ reference: 'RCPT-000140', receivedOn: '2026-10-31', amount: '10000.00' }],
  };
}

export function samplePurchaseOrder(locale: BusinessLocale): PurchaseOrderDocumentData {
  const ar = locale === 'ar';
  return {
    kind: 'purchase_order',
    reference: 'PO-000077',
    issuer: ISSUER[locale],
    footer: FOOTER[locale],
    status: 'approved',
    orderedAt: '2026-10-29T11:00:00Z',
    expectedDate: '2026-11-05',
    supplier: {
      name: ar ? 'الدلتا لقطع غيار التبريد' : 'Delta HVAC Parts',
      address: {
        line1: ar ? '٣ شارع الصناعة' : '3 Industry Road',
        line2: null,
        city: ar ? 'العاشر من رمضان' : '10th of Ramadan',
        postcode: '44629',
      },
      contactName: ar ? 'كريم سامي' : 'Karim Samy',
      email: 'orders@deltahvac.example',
      phone: '+20 15 555 0144',
      taxReference: '300-118-552',
    },
    deliverTo: ar ? 'المستودع الرئيسي – القاهرة الجديدة' : 'Main warehouse – New Cairo',
    notes: ar ? 'يُرجى التسليم بين ٩ صباحًا و٣ مساءً.' : 'Please deliver between 9:00 and 15:00.',
    currencyCode: 'EGP',
    lines: [
      {
        description: ar ? 'فلتر هواء G4 مقاس ٥٩٢×٥٩٢' : 'G4 air filter 592×592',
        sku: 'FLT-G4-592',
        quantity: '48',
        unit: 'each',
        unitPrice: '120.00',
        taxRateBp: 1400,
        subtotal: '5760.00',
      },
      {
        description: ar
          ? 'غاز تبريد R410A أسطوانة ١١٫٣ كجم'
          : 'R410A refrigerant, 11.3 kg cylinder',
        sku: 'GAS-R410A-11',
        quantity: '4',
        unit: 'each',
        unitPrice: '3900.00',
        taxRateBp: 1400,
        subtotal: '15600.00',
      },
      {
        description: ar ? 'كباس سكرول ٥ طن' : 'Scroll compressor, 5 ton',
        sku: 'CMP-SCR-5T',
        quantity: '1',
        unit: 'each',
        unitPrice: '18250.00',
        taxRateBp: 1400,
        subtotal: '18250.00',
      },
    ],
    totals: { subtotal: '39610.00', tax: '5545.40', total: '45155.40' },
  };
}

export function sampleJobReport(
  locale: BusinessLocale,
  photoIds: readonly string[] = [],
  signatureId: string | null = null,
): JobReportData {
  const ar = locale === 'ar';
  const photoTitles = ar
    ? [
        'الوحدة قبل التنظيف',
        'لوحة التحكم',
        'الملف المكثف قبل',
        'الملف بعد التنظيف',
        'الفلاتر الجديدة',
        'قراءة الضغط',
      ]
    : [
        'Unit before cleaning',
        'Control panel',
        'Condenser coil before',
        'Coil after cleaning',
        'New filters fitted',
        'Pressure reading',
      ];
  return {
    kind: 'job_report',
    reference: 'WO-000512',
    issuer: ISSUER[locale],
    footer: FOOTER[locale],
    title: ar ? 'صيانة ربع سنوية – وحدتا السطح' : 'Quarterly service – rooftop units',
    state: 'complete',
    priority: 'normal',
    jobType: ar ? 'صيانة دورية' : 'Planned maintenance',
    createdAt: '2026-10-20T08:00:00Z',
    completedAt: '2026-10-30T13:42:00Z',
    reviewedAt: null,
    description: ar
      ? 'تنظيف الملفات، تغيير الفلاتر، فحص الضغط وإعادة شحن الغاز عند الحاجة لوحدتي السطح RTU-1 وRTU-2.'
      : 'Clean coils, replace filters, check pressures and top up refrigerant where needed on RTU-1 and RTU-2.',
    customer: { name: CUSTOMER[locale].name, accountNumber: 'C-1043', phone: '+20 2 2618 7700' },
    site: {
      name: ar ? 'المبنى B2' : 'Building B2',
      address: CUSTOMER[locale].address,
      location: { latitude: '30.019874', longitude: '31.491302' },
    },
    siteContact: {
      name: ar ? 'حسن فاروق' : 'Hassan Farouk',
      phone: '+20 100 555 0199',
      email: null,
    },
    notes: [
      {
        author: ar ? 'عمر خالد' : 'Omar Khaled',
        at: '2026-10-30T13:30:00Z',
        body: ar
          ? 'تم استبدال الفلاتر في الوحدتين. ننصح بتغيير سير المروحة في RTU-2 خلال الزيارة القادمة.'
          : 'Filters replaced on both units. We recommend replacing the fan belt on RTU-2 at the next visit.',
      },
    ],
    visits: [
      {
        startsAt: '2026-10-29T07:00:00Z',
        endsAt: '2026-10-29T11:00:00Z',
        status: 'done',
        engineers: ar ? ['عمر خالد'] : ['Omar Khaled'],
        completedAt: '2026-10-29T10:55:00Z',
      },
      {
        startsAt: '2026-10-30T08:00:00Z',
        endsAt: '2026-10-30T12:00:00Z',
        status: 'done',
        engineers: ar ? ['عمر خالد', 'يوسف إبراهيم'] : ['Omar Khaled', 'Youssef Ibrahim'],
        completedAt: '2026-10-30T13:40:00Z',
      },
    ],
    times: {
      arrivedAt: '2026-10-29T07:12:00Z',
      startedAt: '2026-10-29T07:25:00Z',
      completedAt: '2026-10-30T13:42:00Z',
      travelMs: 52 * 60_000,
      onSiteMs: 25 * 60_000,
      workMs: 7 * 3_600_000 + 40 * 60_000,
      waitingMs: 45 * 60_000,
    },
    parts: [
      {
        name: ar ? 'فلتر هواء G4 مقاس ٥٩٢×٥٩٢' : 'G4 air filter 592×592',
        sku: 'FLT-G4-592',
        quantity: '24',
        unit: 'each',
        serials: [],
        batches: ['B-2610-07'],
      },
      {
        name: ar ? 'غاز تبريد R410A' : 'R410A refrigerant',
        sku: 'GAS-R410A',
        quantity: '11.5',
        unit: 'kg',
        serials: [],
        batches: [],
      },
      {
        name: ar ? 'حساس ضغط رقمي' : 'Digital pressure sensor',
        sku: 'SNS-PR-01',
        quantity: '2',
        unit: 'each',
        serials: ['PS-88213', 'PS-88214'],
        batches: [],
      },
    ],
    forms: [
      {
        title: ar ? 'قائمة فحص الصيانة الدورية' : 'Planned maintenance checklist',
        status: 'submitted',
        submittedBy: ar ? 'عمر خالد' : 'Omar Khaled',
        submittedAt: '2026-10-30T13:20:00Z',
        documents: [ar ? 'شهادة الصيانة' : 'Service certificate'],
      },
      {
        title: ar ? 'سجل غاز التبريد' : 'Refrigerant log',
        status: 'submitted',
        submittedBy: ar ? 'يوسف إبراهيم' : 'Youssef Ibrahim',
        submittedAt: '2026-10-30T13:35:00Z',
        documents: [],
      },
    ],
    checklist: [
      { label: ar ? 'عزل الكهرباء قبل العمل' : 'Isolate power before work', done: true },
      { label: ar ? 'تنظيف الملفات' : 'Clean coils', done: true },
      { label: ar ? 'تغيير الفلاتر' : 'Replace filters', done: true },
      { label: ar ? 'فحص سير المروحة' : 'Check fan belt', done: false },
    ],
    photos: photoIds.map((fileId, index) => ({
      fileId,
      title: photoTitles[index % photoTitles.length] ?? '',
      stage: index < 3 ? 'before' : index < 6 ? 'after' : null,
    })),
    morePhotos: 0,
    signoff: {
      signedAt: '2026-10-30T13:41:00Z',
      name: ar ? 'حسن فاروق' : 'Hassan Farouk',
      role: ar ? 'مدير المرافق' : 'Facilities manager',
      signatureFileId: signatureId,
      unavailableReason: null,
    },
  };
}

export function sampleDocument(
  kind: BusinessDocumentKind,
  locale: BusinessLocale,
): BusinessDocumentData {
  switch (kind) {
    case 'quote':
      return sampleQuote(locale);
    case 'invoice':
      return sampleInvoice(locale);
    case 'purchase_order':
      return samplePurchaseOrder(locale);
    case 'job_report':
      return sampleJobReport(locale);
  }
}
