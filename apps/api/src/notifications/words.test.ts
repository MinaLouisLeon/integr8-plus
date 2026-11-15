import { describe, expect, it } from 'vitest';
import {
  contractRenewalEmail,
  deadlineAlertEmail,
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

  it('are written in English unless told otherwise, and name the screen instead of linking', () => {
    const message = contractRenewalEmail({
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
    });
    expect(message.subject).toBe('Contracts ending soon — Nile Services');
    expect(message.text).toContain('SC-0001 Chillers for Delta Mall ends on 31 December 2026.');
    expect(message.html).toContain('dir="ltr"');
    // No web workspace to link to since P42: the office opens its desktop app.
    expect(message.text).toContain('Open Contracts in your company’s desktop app.');
    expect(message.html).not.toContain('<a href');
    expect(message.actionUrl).toBeUndefined();
  });

  it('are written in Arabic, right to left, for a company that uses Arabic', () => {
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
      locale: 'ar',
    });
    expect(certificates.subject).toBe('شهادات منتهية الصلاحية — Nile Services');
    expect(certificates.html).toContain('dir="rtl"');
    expect(certificates.text).toContain('افتح الشهادات في تطبيق سطح المكتب الخاص بشركتك.');
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
        },
      ],
      locale: 'ar',
    });
    expect(deadlines.subject).toBe('مواعيد نهائية فائتة — Nile Services');
    expect(deadlines.text).toContain('WO-0007 Leak (Delta Mall): كان موعد الاستجابة');
  });
});
