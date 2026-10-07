/**
 * The help centre's content (P18).
 *
 * Fifteen articles, which is what the plan asks for. The plan also asks for
 * them to be *written from real support questions*, and they are not, **because
 * there are no customers yet and therefore no support questions.** Inventing
 * fifteen quotes from imaginary users would be worse than admitting it, so the
 * help page says so at the top and these are written from how the product
 * actually behaves.
 *
 * They are chosen by working through what a new company does in its first week
 * and what each step can go wrong in — which is the best available proxy, and
 * the right set to replace first once real questions exist.
 *
 * Content in a TypeScript module rather than a CMS or markdown files because
 * there is no content pipeline in this repository, and inventing one for
 * fifteen articles would be the tail wagging the dog. Moving them later is a
 * find-and-replace.
 */

export interface HelpArticle {
  slug: string;
  category: 'getting-started' | 'forms' | 'mobile' | 'people' | 'billing';
  question: string;
  /** Paragraphs. Rendered in order, no markup. */
  answer: string[];
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'what-do-i-do-first',
    category: 'getting-started',
    question: 'My company has just been set up. What should I do first?',
    answer: [
      'Rename the job types to match the work you actually do. We put five in to start with — installation, planned maintenance, repair, inspection and callout — and they are only a starting point.',
      'Then create one form, invite one engineer, and fill the form in yourself on a phone. Doing the whole loop once, badly, teaches you more than setting everything up perfectly before anybody uses it.',
      'The checklist on your dashboard tracks these. It is computed from what actually exists, so it is never out of date.',
    ],
  },
  {
    slug: 'sample-data',
    category: 'getting-started',
    question: 'What is the sample data, and is it safe to remove?',
    answer: [
      'Three customers, each with a site and a job, so the screens are not empty while you look around. Every row is marked as a sample.',
      'Removing it only removes rows that are still marked. If you edit one of them into a real customer, that mark is cleared and removal leaves it alone.',
      'You can load it and remove it as often as you like. It never touches anything you created yourself.',
    ],
  },
  {
    slug: 'import-from-spreadsheet',
    category: 'getting-started',
    question: 'Can I bring my customers in from a spreadsheet?',
    answer: [
      'Yes. Go to Import and upload a CSV. You match your columns to ours on the next screen, so the file does not have to be in any particular shape.',
      'Nothing is written until you have seen exactly what will be created, including any rows that cannot be read. Fix those in the file and upload it again.',
    ],
  },
  {
    slug: 'build-a-form',
    category: 'forms',
    question: 'How do I build a form?',
    answer: [
      'Start from one of the six templates and change it — that is almost always faster than starting from nothing, and the templates are built from forms that are genuinely used.',
      'A form is pages, sections and questions. A question can be required, can have a numeric range, and can be shown only when an earlier answer says so, which is how you keep a routine job down to a few taps.',
      'Nothing is live until you publish it.',
    ],
  },
  {
    slug: 'change-a-published-form',
    category: 'forms',
    question: 'I changed a form. What happens to the jobs already filled in?',
    answer: [
      'Nothing. A published version is frozen: a submission made against version 1 still shows version 1, with the questions as they were worded and the answers as they were given.',
      'New submissions use the latest published version. The two live alongside each other for as long as you keep the records.',
    ],
  },
  {
    slug: 'breaking-changes',
    category: 'forms',
    question: 'Why is it warning me about a breaking change?',
    answer: [
      'Because you have removed a question, or made an optional one required, or narrowed what an answer can be. Anything already saved as a draft against the old version may no longer be valid.',
      'It is a warning, not a refusal. You can publish anyway once you have acknowledged it.',
    ],
  },
  {
    slug: 'no-signal',
    category: 'mobile',
    question: 'What happens when an engineer has no signal?',
    answer: [
      'They carry on. The form is filled in on the device and stored there, photos and signatures included.',
      'When there is signal again the app sends everything, in order, without anybody pressing anything. This is the normal case, not an error state.',
    ],
  },
  {
    slug: 'sync-stuck',
    category: 'mobile',
    question: 'An engineer says their app is stuck. What do I do?',
    answer: [
      'First, have them open the app with signal and leave it open for a minute. Almost everything clears itself.',
      'If it does not, contact us and we can reset their device from our side. Their phone then downloads everything again. Nothing waiting to be sent is lost when we do this.',
    ],
  },
  {
    slug: 'photos-quality',
    category: 'mobile',
    question: 'Are photos compressed? Will they still be readable?',
    answer: [
      'They are compressed on the phone before being uploaded, which is what makes them send over a weak connection at all.',
      'The compression is chosen so a serial number or a meter reading stays legible. If you have a case where it is not, tell us — that is a setting worth getting right.',
    ],
  },
  {
    slug: 'invite-an-engineer',
    category: 'people',
    question: 'How do I invite an engineer?',
    answer: [
      'People, then Invite somebody. They get an email with a link that sets up their account.',
      'The link expires after a week. If it goes astray, use Send again — that issues a new link and stops the old one working, which is what you want if the first one went to the wrong place.',
    ],
  },
  {
    slug: 'roles',
    category: 'people',
    question: 'What can each role do?',
    answer: [
      'An owner can do everything, including billing and closing the account. An admin can do everything except billing and company settings.',
      'A dispatcher manages jobs, customers and sites. An engineer does the work assigned to them and fills in forms. A viewer can read and nothing else.',
      'Nobody can give somebody a role above their own.',
    ],
  },
  {
    slug: 'somebody-left',
    category: 'people',
    question: 'Somebody has resigned. Should I remove them or suspend them?',
    answer: [
      'Suspend them if they might come back, or if you are not sure — it is reversible and takes their seat back the moment you do it.',
      'Remove them if they have gone for good. Either way, everything they filled in, signed and submitted stays, and the history still names them.',
      'One thing worth knowing: both stop them signing in immediately, but a session they already have open can keep working for up to fifteen minutes. If somebody departed in difficult circumstances, tell us and we can cut it off at once.',
    ],
  },
  {
    slug: 'what-counts-as-a-seat',
    category: 'billing',
    question: 'What counts as a seat?',
    answer: [
      'An active member of your company, whatever their role. Somebody you have invited but who has not joined yet does not take a seat until they accept.',
      'Suspending or removing somebody frees their seat immediately.',
    ],
  },
  {
    slug: 'what-if-i-dont-pay',
    category: 'billing',
    question: 'What happens if a payment fails?',
    answer: [
      'We tell you in the app and email the owners and admins, and you have a fortnight to fix it.',
      'If it is still outstanding after that, the account becomes read-only: everybody can still sign in, read everything and export it, but new work cannot be saved. Nothing is deleted, and nothing ever will be for non-payment.',
      'Updating the card restores writing immediately.',
    ],
  },
  {
    slug: 'export-everything',
    category: 'billing',
    question: 'Can I get all my data out?',
    answer: [
      'Yes, whenever you ask, including while your account is read-only. Ask us and you get a single file with everything in it.',
      'This is deliberate. Data you cannot get out is data you do not really own.',
    ],
  },
];

export const HELP_CATEGORIES = [
  { key: 'getting-started', label: 'Getting started' },
  { key: 'forms', label: 'Forms' },
  { key: 'mobile', label: 'On the van' },
  { key: 'people', label: 'People' },
  { key: 'billing', label: 'Billing' },
] as const;
