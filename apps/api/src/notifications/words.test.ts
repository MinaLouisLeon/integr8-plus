import { describe, expect, it } from 'vitest';
import {
  contractRenewalEmail,
  deadlineAlertEmail,
  dunningEmail,
  qualificationExpiryEmail,
} from '../email/messages.js';
import { fill, messageLocale, wordsFor } from './words.js';

describe('the language a message is written in', () => {
  it('is Arabic for any Arabic tag, and English for anything else or nothing', () => {
    expect(messageLocale('ar')).toBe('ar');
    expect(messageLocale('ar-EG')).toBe('ar');
    expect(messageLocale(' AR ')).toBe('ar');
    expect(messageLocale('en')).toBe('en');
    expect(messageLocale('fr')).toBe('en');
    expect(messageLocale(null)).toBe('en');
    expect(messageLocale(undefined)).toBe('en');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(fill(wordsFor('en').push.newJob, { job: 'WO-1 · Boiler' })).toBe(
      'New job: WO-1 · Boiler',
    );
    expect(fill(wordsFor('ar').push.newJob, { job: 'WO-1' })).toBe('مهمة جديدة: WO-1');
    expect(fill('{{missing}}', {})).toBe('{{missing}}');
  });
});

describe('reminder emails', () => {
  const base = { to: 'owner@test.integr8.example', companyName: 'Nile Services' };

  it('are written in English unless told otherwise, as before', () => {
    const message = dunningEmail({
      ...base,
      billingUrl: 'https://app.test/billing',
      deadline: new Date('2026-11-14T10:00:00Z'),
      readOnly: false,
    });
    expect(message.subject).toBe('Payment failed for Nile Services');
    expect(message.text).toContain('If it is still outstanding on 14 November 2026');
    expect(message.html).toContain('dir="ltr"');
    expect(message.html).toContain('Or paste this into your browser:');
  });

  it('are written in Arabic, right to left, for a company that uses Arabic', () => {
    const dunning = dunningEmail({
      ...base,
      billingUrl: 'https://app.test/billing',
      deadline: null,
      readOnly: true,
      locale: 'ar',
    });
    expect(dunning.subject).toBe('Nile Services للقراءة فقط — توجد دفعة مستحقة');
    expect(dunning.html).toContain('dir="rtl"');
    expect(dunning.html).toContain('أو الصق هذا الرابط في متصفحك:');

    const certificates = qualificationExpiryEmail({
      ...base,
      items: [
        {
          person: 'Omar',
          qualification: 'Gas Safe',
          expiresOn: '2026-12-01',
          stage: 'lapsed',
          affectedVisits: [],
        },
      ],
      own: false,
      url: 'https://app.test/qualifications',
      locale: 'ar',
    });
    expect(certificates.subject).toBe('شهادات منتهية الصلاحية — Nile Services');
    expect(certificates.text).toContain('Omar: انتهت صلاحية Gas Safe في');

    const contracts = contractRenewalEmail({
      ...base,
      items: [
        {
          reference: 'SC-0001',
          title: 'Chillers',
          customer: 'Delta Mall',
          endsOn: '2026-12-31',
          stage: 'notice',
        },
      ],
      url: null,
      locale: 'ar',
    });
    expect(contracts.subject).toBe('عقود تنتهي قريبًا — Nile Services');
    expect(contracts.text).toContain('SC-0001 Chillers للعميل Delta Mall ينتهي في');

    const deadlines = deadlineAlertEmail({
      ...base,
      items: [
        {
          job: 'WO-0007 Leak',
          customer: 'Delta Mall',
          kind: 'response',
          dueAt: '1 Dec 2026, 10:00',
          stage: 'missed',
          url: null,
        },
      ],
      url: null,
      locale: 'ar',
    });
    expect(deadlines.subject).toBe('مواعيد نهائية فائتة — Nile Services');
    expect(deadlines.text).toContain('WO-0007 Leak (Delta Mall): كان موعد الاستجابة');
  });
});
