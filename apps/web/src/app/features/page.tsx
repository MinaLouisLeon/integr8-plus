'use client';

import { useTranslation } from '@integr8/i18n';
import { GetStartedLink, MarketingShell } from '~/components/marketing-shell';

/**
 * Features (P18).
 *
 * The whole product, grouped by the question somebody is actually asking, with
 * no adjectives. Each entry describes something that exists today — if one
 * stops being true, that is a bug in the product or a lie on this page, and
 * both are worth fixing.
 *
 * Written in English here rather than through the translation layer for the
 * body copy, because this is marketing prose that will be rewritten by whoever
 * owns the positioning, and threading forty sentences through i18n keys before
 * anybody has agreed the words is work thrown away twice.
 */

interface Group {
  title: string;
  items: { title: string; body: string }[];
}

const GROUPS: readonly Group[] = [
  {
    title: 'On the van',
    items: [
      {
        title: 'Works with no signal',
        body: 'Forms are filled in on the device and stored there. When there is signal again they are sent, in order, without anybody pressing anything. A plant room, a loft or a lift shaft is the normal case, not the exception.',
      },
      {
        title: 'Photos and signatures',
        body: 'Taken on the phone, compressed on the phone, attached to the job. A signature is captured on the screen and stored with the submission it belongs to.',
      },
      {
        title: 'The day, on one screen',
        body: 'An engineer sees the jobs assigned to them, in order, with the site address, the forms to fill in and what was done last time.',
      },
    ],
  },
  {
    title: 'In the office',
    items: [
      {
        title: 'Your forms, not ours',
        body: 'Build the form you already use on paper: sections, conditional questions, numeric ranges, required photos. Publish it and it is on every phone at the next sync.',
      },
      {
        title: 'Versions that hold still',
        body: 'A published version is frozen. A job filled in last March still reads exactly as it was signed, even after the form has changed four times since.',
      },
      {
        title: 'Customers, sites and jobs',
        body: 'Who they are, where the work is, and what needs doing. Import the lot from a spreadsheet on the first day.',
      },
      {
        title: 'Timesheets from the work',
        body: 'Time comes from jobs being started and finished rather than from somebody filling in a second system at the end of the week.',
      },
    ],
  },
  {
    title: 'Behind it',
    items: [
      {
        title: 'Every change is recorded',
        body: 'Who changed what, and when, in a log nothing can delete. Corrections keep the original alongside the reason it was corrected.',
      },
      {
        title: 'Your data is yours',
        body: 'Export everything you have, whenever you ask. If you stop paying the account becomes read-only — nothing is deleted, and you can still read and export all of it.',
      },
      {
        title: 'Storage you can see',
        body: 'What you are using, what your plan allows, and a warning well before you reach it rather than a failed upload from a roof.',
      },
    ],
  },
];

export default function FeaturesPage() {
  const { t } = useTranslation();

  return (
    <MarketingShell step="features.viewed">
      <header className="flex flex-col gap-2 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-content">
          {t('marketing.features.title')}
        </h1>
        <p className="text-content-muted">{t('marketing.features.subtitle')}</p>
      </header>

      <div className="flex flex-col gap-10">
        {GROUPS.map((group) => (
          <section key={group.title} className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold text-content">{group.title}</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {group.items.map((item) => (
                <div key={item.title} className="flex flex-col gap-1">
                  <h3 className="text-base font-medium text-content">{item.title}</h3>
                  <p className="text-sm text-content-muted">{item.body}</p>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="pt-10">
        <GetStartedLink />
      </div>
    </MarketingShell>
  );
}
