/**
 * The legal pages, in English: the terms of service, the privacy policy and
 * the data processing terms (pre-production audit, High 10). Arabic is in
 * `legal.ar.ts`; `docs/legal/README.md` says what each covers and who must
 * review them before launch.
 *
 * Written from what the product does, checked against the code and the docs,
 * in plain words: the people reading them run service companies, not legal
 * departments. When the product changes what it collects, where data goes or
 * how long it stays, these change with it, and so does `LEGAL_LAST_UPDATED`
 * in `@integr8/core`.
 *
 * Each section's `body` is plain text with two rules the page renders: a blank
 * line starts a new paragraph, and lines starting with "- " are a list. No
 * other markup, so a translator sees sentences and nothing to break.
 */
export const legalEn = {
  nav: 'Legal',
  lastUpdated: 'Last updated {{date}}',
  underReview:
    'This text is awaiting review by a lawyer. It describes how Integr8 Plus works today; the wording may change after the review, and the date above will change with it.',
  contents: 'On this page',
  documents: {
    terms: 'Terms of service',
    privacy: 'Privacy policy',
    dpa: 'Data processing terms',
  },
  // Under the sign-up form, above the links to all three.
  agreement:
    'By creating your company you accept the terms of service and the data processing terms, and confirm that you have read the privacy policy.',
  operator: {
    title: 'Who provides Integr8 Plus',
    legalName: 'Registered name',
    registeredAddress: 'Registered address',
    commercialRegistration: 'Commercial registration',
    taxRegistration: 'Tax registration',
    email: 'Email',
    hostingLocation: 'Where the server runs',
  },

  terms: {
    summary:
      'The agreement between Integr8 and each company that uses Integr8 Plus: what we provide, what the company is responsible for, and what happens when the service ends.',
    sections: {
      about: {
        title: 'About these terms',
        body:
          'Integr8 Plus is a field-operations and business system that Integr8 ("Integr8", "we") provides to companies ("the company", "you"). It includes the website, the web app, and the desktop and phone apps made for each company.\n\n' +
          'These terms are the agreement between Integr8 and the company. They apply from the day the company’s account is created, whether Integr8 set it up or the company signed up on the website. A signed order can add to them, for example a price or a plan; where the two differ, the order applies.\n\n' +
          'The people a company invites, such as its owner, office staff and engineers, use Integr8 Plus on the company’s behalf, and the company is responsible for them following these terms.\n\n' +
          'The data processing terms and the privacy policy are part of this agreement.',
      },
      service: {
        title: 'The service',
        body:
          'Integr8 sets up each company: its account, its forms and job types, its branding and the apps its people install. Some settings stay with Integr8 for that reason, namely forms, job types, branding, document design and the e-invoicing switch, and we change them at the company’s request.\n\n' +
          'Each business module, such as sales, finance, inventory, HR or payroll, is switched on for a company when its plan or order includes it. The limits of a plan, such as the number of people, submissions and storage, are enforced by the system itself.\n\n' +
          'We keep improving Integr8 Plus. We may change or remove a feature, but we will not remove one that a company relies on without telling it in advance.',
      },
      accounts: {
        title: 'Accounts and access',
        body:
          'The company’s owner decides who has an account and what each person may do. Each person signs in with their own email address, and accounts must not be shared.\n\n' +
          'Keep passwords and sign-in codes secret, and tell us straight away if you think an account has been misused. The company is responsible for what is done through its accounts, except where a failure on our side caused it.\n\n' +
          'When somebody leaves, remove them from the company. Their access ends, and a phone they used is cleared of the company’s data the next time it connects.',
      },
      data: {
        title: 'Your data',
        body:
          'The company owns everything it puts into Integr8 Plus: its customers, sites, jobs, forms and their answers, photos, signatures, documents, business records and its people’s details ("company data").\n\n' +
          'Integr8 uses company data only to provide the service to the company, as the data processing terms describe. We do not sell it, use it for advertising, or use it to train AI models.\n\n' +
          'The company can export its lists from the apps at any time, and can ask Integr8 for a complete export of its account.',
      },
      acceptableUse: {
        title: 'Acceptable use',
        body:
          'The company and its people must not:\n' +
          '- use Integr8 Plus for anything unlawful, or to keep content they have no right to keep;\n' +
          '- try to reach another company’s data, or test the security of the system without our written permission;\n' +
          '- copy, resell or reverse-engineer Integr8 Plus, or use it to build a competing product;\n' +
          '- overload the system, for example with automated requests beyond normal use;\n' +
          '- upload viruses or other harmful files.\n\n' +
          'The company is responsible for collecting the personal data it keeps in Integr8 Plus lawfully, including under Egypt’s Personal Data Protection Law (Law No. 151 of 2020): for example, by telling its customers and employees what it records about them.',
      },
      staffAccess: {
        title: 'When Integr8 staff use your account',
        body:
          'To set up a company and to answer its support requests, Integr8 staff can act inside its account. They can do so only through an access grant that records who is acting, why and for how long. While it lasts, every screen shows a banner, and every action is recorded in the company’s own audit log as well as in ours.\n\n' +
          'Integr8 staff never need anybody’s password, and will never ask for one.',
      },
      fees: {
        title: 'Plans, fees and payment',
        body:
          'The price of a plan is the one in the company’s order or, for a company that signs up on the website, the one on the pricing page. Taxes are added where the law requires.\n\n' +
          'A company that signs up on the website can try Integr8 Plus for fourteen days without a card, and then pays by card through Stripe. Other companies pay as their order says.\n\n' +
          'If a payment fails, or a trial ends unpaid, we remind the company in the apps, and its owners and admins by email. After a grace period of fourteen days the account becomes read-only: its people can still see their records and export them, but cannot add or change anything until the bill is paid.',
      },
      suspension: {
        title: 'Suspension',
        body: 'We may suspend a company’s account if a bill is still unpaid after the account has become read-only, if the account is used in breach of these terms, or if we must to protect the system or other companies. While an account is suspended nobody can use it, and the apps say why. We tell the company before suspending it unless the reason makes that impossible, and restore access once the reason is resolved.',
      },
      availability: {
        title: 'Availability',
        body:
          'We work to keep Integr8 Plus available at all times, but cannot promise that it will never be interrupted. Where we can, planned maintenance is announced in the apps beforehand.\n\n' +
          'Engineers can keep working in the phone app without a connection; their work is sent when the phone is back online.',
      },
      records: {
        title: 'Records you remain responsible for',
        body:
          'Integr8 Plus calculates figures to help a company run its business: payroll under Egyptian rules, the general ledger, the taxes on invoices, and electronic invoices for the Egyptian Tax Authority. These are management tools. The company remains responsible for checking the figures and for its own legal obligations, including tax, social insurance and employment filings.\n\n' +
          'E-invoicing is switched on only at a company’s request, and sends documents under the company’s own Tax Authority registration and credentials. Until Integr8 tells a company in writing that e-invoicing is ready for live documents, it sends them only to the Tax Authority’s test environment.',
      },
      assistant: {
        title: 'The assistant',
        body: 'Where a company has the assistant switched on, its answers come from Integr8’s help library or, if the company’s plan includes it, from an AI model. Answers can be wrong, so check them before relying on them. The assistant never changes a record by itself: anything it proposes happens only when a person confirms it.',
      },
      ending: {
        title: 'Ending the agreement',
        body:
          'The company can end the agreement as its plan or order allows. Integr8 can end it with thirty days’ notice, or at once if the company seriously breaches these terms and does not put it right after being told.\n\n' +
          'When an account is closed, Integr8 first makes a complete export of the company’s data, which the company can download for thirty days. The account is suspended, and seven days later all of its data is permanently deleted. Until then the closure can be cancelled.',
      },
      liability: {
        title: 'Liability',
        body:
          'We provide Integr8 Plus with reasonable skill and care. Beyond that, and as far as the law allows, it is provided as it is, without other promises.\n\n' +
          'Neither side is liable for indirect losses, such as lost profit or lost business. Integr8’s total liability under this agreement is limited to the fees the company paid in the twelve months before the claim.\n\n' +
          'Nothing in these terms limits a liability that Egyptian law does not allow to be limited, such as liability for fraud or gross negligence.',
      },
      changes: {
        title: 'Changes to these terms',
        body: 'We may update these terms. We tell companies about a significant change at least thirty days before it takes effect, by email and in the apps. The date at the top of this page shows when the terms last changed.',
      },
      law: {
        title: 'Governing law',
        body: 'These terms are governed by the laws of the Arab Republic of Egypt. A dispute that cannot be settled by discussion goes to the competent courts of Cairo.',
      },
      contact: {
        title: 'Contact',
        body: 'Write to us at {{email}}. Integr8’s details are below.',
      },
    },
  },

  privacy: {
    summary:
      'What personal data Integr8 Plus handles, why, who else sees it, how long it is kept, and the rights of the people it is about.',
    sections: {
      who: {
        title: 'Who we are',
        body: 'Integr8 Plus is provided by Integr8 ("Integr8", "we"). This policy covers the website, the web app, and the desktop and phone apps. Integr8’s details are at the end of this page.',
      },
      roles: {
        title: 'The company decides, Integr8 processes',
        body:
          'Most of the personal data in Integr8 Plus is put there by a company that uses it: about its people, its customers and their sites, its jobs, forms and records. For that data the company is the controller, which decides what is collected and why, and Integr8 is its processor: we keep and process the data only to provide the service, under the data processing terms. If your data is in a company’s account, that company is the one to ask about it first.\n\n' +
          'Integr8 is the controller of the data it uses for its own purposes: its contracts with companies and their billing, support conversations, sign-ups on the website, visits to the website, and the security records that protect the service, such as failed sign-in attempts.',
      },
      collect: {
        title: 'What we collect',
        body:
          'About everybody with an account:\n' +
          '- name, email address, role and company;\n' +
          '- a password, which the sign-in service keeps only in a scrambled form that cannot be turned back into the password, and the six-digit sign-in codes we email on request;\n' +
          '- sessions: the app and device used, the IP address, and when they were last used;\n' +
          '- failed sign-in attempts, to stop anybody guessing passwords.\n\n' +
          'What a company puts in, depending on the modules it uses:\n' +
          '- customers, their contacts and their sites, including addresses, map positions and access notes;\n' +
          '- jobs, visits, schedules, timesheets and the engineers assigned to them;\n' +
          '- forms and their answers, photos, signatures, files and certificates;\n' +
          '- quotes, orders, invoices, payments, stock, purchases, assets and contracts;\n' +
          '- HR and payroll: employee profiles, pay, expense claims and their receipts, and national ID, social insurance and bank account numbers.\n\n' +
          'From the phone app, only while it is being used:\n' +
          '- location, when an engineer submits a form, to record where it was submitted, or fills in a location question; never in the background;\n' +
          '- the camera and photos, when somebody takes or adds a picture or scans a barcode; photos are made smaller on the phone before they are sent, which removes the hidden details a camera adds, including the location;\n' +
          '- the microphone, only when somebody taps it to ask the assistant a question; the phone’s own speech service turns the question into text, and no audio reaches Integr8;\n' +
          '- Face ID or a fingerprint, if somebody chooses to unlock the app that way; the phone checks it, and Integr8 never receives it;\n' +
          '- a notification token, so the phone can be told about new work.\n\n' +
          'When a company uses the assistant: the questions asked and the answers given.\n\n' +
          'From the website: what you type into its forms, for example to sign up, and a count of how many visitors reach each step of signing up, which records nothing about who they are.',
      },
      use: {
        title: 'Why we use it',
        body:
          'We use personal data to:\n' +
          '- provide Integr8 Plus to the company that uses it, under our agreement with that company;\n' +
          '- sign people in and keep accounts secure, including against password guessing and misuse;\n' +
          '- send the emails the service needs: invitations, sign-in codes, and notices about an account and its bills;\n' +
          '- give support, which can mean a member of Integr8’s staff working inside a company’s account, as described under "How we protect it";\n' +
          '- bill companies and keep the records the law requires;\n' +
          '- find and fix faults.\n\n' +
          'We rely on our contracts with companies, on our legal obligations, and on our legitimate interest in keeping the service secure and working. A company relies on its own grounds for the data it puts in.\n\n' +
          'We do not sell personal data, show advertising, or use a company’s data to train AI models.',
      },
      cookies: {
        title: 'Cookies and storage on your device',
        body:
          'Integr8 Plus uses no advertising or tracking cookies. The website sets only the cookies it needs: one that keeps you signed in, which scripts on the page cannot read, and others that remember your language, the colour theme and whether the menu is open.\n\n' +
          'The apps also keep a few preferences on your device, such as your company’s name and colours for the sign-in screen and which announcements you have closed. The desktop and phone apps keep sign-in details in the protected storage of the operating system.',
      },
      sharing: {
        title: 'Who else handles it',
        body:
          'We use these service providers to run Integr8 Plus. Each receives only what its task needs:\n' +
          '- Oracle Cloud hosts our server: the database, the sign-in service and the backups.\n' +
          '- Cloudflare R2 stores files, such as photos, signatures, documents and exports, in separate storage for each company.\n' +
          '- Resend sends our emails: it receives each recipient’s address and the message.\n' +
          '- Sentry receives reports of software errors. We have switched off the sending of personal details with them, such as who was signed in, cookies and what was typed.\n' +
          '- Mapbox turns site addresses into map positions. The apps show no map of their own: “Open in Google Maps” opens Google’s site with a position, only when somebody clicks it.\n' +
          '- Expo delivers notifications to phones, through Apple and Google, and delivers updates to the phone app.\n' +
          '- Stripe takes card payments, only for companies that pay by card on the website. Card details go to Stripe directly; we never see them.\n' +
          '- An AI model provider, currently OpenAI, receives the questions put to the assistant, only for a company whose assistant answers from a model. Company records are sent with a question only if Integr8 has allowed it for that company, which it does only at the company’s request.\n' +
          '- The Egyptian Tax Authority receives a company’s invoices only when the company switches on e-invoicing, and receives them under the company’s own registration.\n\n' +
          'Apple and Google also run the app stores and, when somebody speaks a question, the phone’s speech recognition.\n\n' +
          'We disclose personal data to public authorities only when the law requires it.',
      },
      location: {
        title: 'Where it is stored',
        body: 'Our server runs in a data centre operated by Oracle Cloud, and files are kept by Cloudflare. These and the other providers above may store or process data outside Egypt, including in the European Union and the United States. Wherever data goes, it travels over encrypted connections, and each provider is bound by its terms with us to protect it.',
      },
      security: {
        title: 'How we protect it',
        body:
          '- The database itself keeps each company’s data apart: every request is limited to the company of the person making it, so one company cannot reach another’s records.\n' +
          '- Everything travels over encrypted connections. Files are never public: each upload or download uses a link that expires within minutes.\n' +
          '- National ID, social insurance and bank account numbers are encrypted before they are stored, and lists show only their last four characters. Seeing a full number needs a specific permission, and every time one is shown is recorded.\n' +
          '- On phones, the app keeps its data in an encrypted database, and deletes it when the person signs out or their access is removed.\n' +
          '- Important actions are recorded in an audit log the company can read. Integr8’s own log of staff actions is built so that it cannot be changed or deleted.\n' +
          '- Integr8 staff sign in with a password and an authenticator code. They can act inside a company’s account only through an access grant that records who, why and for how long, shows a banner on every screen while it lasts, and is recorded in both audit logs.\n' +
          '- The database is backed up every night.',
      },
      retention: {
        title: 'How long we keep it',
        body:
          '- A company’s data is kept for as long as the company has an account. Apart from conversations with the assistant, nothing is deleted automatically unless a retention period is set.\n' +
          '- Conversations with the assistant are deleted after the period set for the company, thirty days unless another has been agreed, or sooner if the person deletes them.\n' +
          '- A plan can have a retention period after which old files are removed. Integr8 sets one only after telling the companies on that plan, and a company’s logo and app icon are never removed.\n' +
          '- A deleted file can be restored for thirty days; then it is permanently deleted.\n' +
          '- When a company closes its account, Integr8 makes a complete export of its data, which the company can download for thirty days. Seven days after the closure, all of the company’s data is permanently deleted, including its people’s sign-in accounts, unless they also belong to another company on Integr8 Plus.\n' +
          '- Deleted data can stay in backups until they are replaced: the nightly database copies after fourteen days, and copies of the whole server when the hosting provider’s backup schedule replaces them.\n' +
          '- After a company is deleted, Integr8 keeps the record of what its staff did on the company’s account, and keeps billing records for as long as the law requires.',
      },
      rights: {
        title: 'Your rights',
        body:
          'Egypt’s Personal Data Protection Law (Law No. 151 of 2020) gives you rights over your personal data, including the right to:\n' +
          '- know what data is held about you, and receive a copy;\n' +
          '- have data that is wrong or incomplete corrected;\n' +
          '- have data deleted when it is no longer needed or was processed unlawfully;\n' +
          '- withdraw consent you have given, object to processing, or ask for it to be limited;\n' +
          '- be told if your data is involved in a security breach.\n\n' +
          'If your data is in a company’s account, as one of its people or as one of its customers, ask that company: it decides what happens to the data, and Integr8 helps it answer. If you write to us instead, we pass your request on to the company and tell you that we have.\n\n' +
          'For data Integr8 controls, write to {{email}}. We may ask you to confirm who you are before we act.\n\n' +
          'If you are not satisfied with an answer, you can complain to Egypt’s Personal Data Protection Center.',
      },
      children: {
        title: 'Children',
        body: 'Integr8 Plus is made for businesses and is not meant for children. A company that records details of a child, for example as a customer contact, is responsible for doing so lawfully.',
      },
      changes: {
        title: 'Changes to this policy',
        body: 'When we change this policy, we change the date at the top of this page. If a change affects how your data is used, we tell companies in the apps and by email before it takes effect.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions about this policy, or about data Integr8 controls: {{email}}. Integr8’s details are below.',
      },
    },
  },

  dpa: {
    summary:
      'How Integr8 handles the personal data a company puts into Integr8 Plus, as that company’s processor. These terms are part of the terms of service.',
    sections: {
      scope: {
        title: 'Scope and roles',
        body: 'These terms apply to the personal data a company puts into Integr8 Plus or collects through it ("company personal data"). The company is the controller of that data, and Integr8 is its processor. These terms are part of the terms of service; where the two differ about personal data, these terms apply.',
      },
      details: {
        title: 'What is processed',
        body:
          'People concerned: the company’s own people, such as its owners, office staff, engineers and other employees; its customers and their contacts; its suppliers and leads; and anybody else whose details the company records.\n\n' +
          'Data concerned: names and contact details; addresses, sites and map positions; work records, schedules and timesheets; form answers, photos, signatures and files, which hold whatever the company’s forms ask for; business and financial records; the place a form was submitted from a phone; and, if the company uses HR and payroll, employment and pay details and national ID, social insurance and bank account numbers.\n\n' +
          'Purpose: providing Integr8 Plus to the company, which means storing, organising, showing, syncing, sending and exporting this data as the company uses the service.\n\n' +
          'Duration: for as long as the company has an account, and until the data is deleted as described under "When the agreement ends".',
      },
      instructions: {
        title: 'Integr8 follows the company’s instructions',
        body:
          'Integr8 processes company personal data only to provide the service, following the company’s instructions. The company gives them through the agreement, through what it does in the apps, and through its support requests. Integr8 tells the company if it believes an instruction breaks the law, and does not use company personal data for any purpose of its own: not for advertising, not for sale, and not to train AI models.\n\n' +
          'If the law requires Integr8 to disclose company personal data, Integr8 tells the company first, unless the law forbids it.',
      },
      people: {
        title: 'Integr8’s staff',
        body: 'Only Integr8 staff who need access to set up or support a company have it, and they are bound to keep what they see confidential. They act inside a company’s account only through an access grant that records who, why and for how long; a banner shows on every screen while it lasts, and each action is recorded in the company’s audit log.',
      },
      security: {
        title: 'Security',
        body:
          'Integr8 keeps at least these measures in place:\n' +
          '- each company’s data kept apart by the database itself, so that every request reaches only its own company’s records;\n' +
          '- encrypted connections, and files kept private behind links that expire within minutes;\n' +
          '- national ID, social insurance and bank account numbers encrypted before they are stored, shown in full only to people with the permission, and every showing recorded;\n' +
          '- an encrypted database on phones, cleared when a person signs out or loses access;\n' +
          '- an audit log the company can read, and a log of staff actions built so that it cannot be altered;\n' +
          '- staff sign-in with a password and an authenticator code;\n' +
          '- nightly backups.',
      },
      subprocessors: {
        title: 'Sub-processors',
        body:
          'The company authorises Integr8 to use these sub-processors, each only for its task:\n' +
          '- Oracle Cloud: hosting the server, the database and the backups;\n' +
          '- Cloudflare R2: storing files;\n' +
          '- Resend: sending email;\n' +
          '- Sentry: error reports, with personal details switched off;\n' +
          '- Mapbox: turning site addresses into map positions;\n' +
          '- Expo: delivering notifications and app updates to phones;\n' +
          '- Stripe: card payments, only for companies that pay by card on the website;\n' +
          '- an AI model provider, currently OpenAI: only when the company’s assistant answers from a model, and with company records only if the company asked Integr8 to allow it.\n\n' +
          'Integr8 requires each sub-processor to protect the data at least as these terms do, and remains responsible for them. Before adding or replacing one, Integr8 tells the company, in the apps or by email, at least thirty days ahead; a company that objects on reasonable grounds can end the agreement before the change.\n\n' +
          'The Egyptian Tax Authority is not a sub-processor: when a company switches on e-invoicing, the company itself sends its invoices to the Authority, through Integr8 Plus.',
      },
      transfers: {
        title: 'Transfers outside Egypt',
        body: 'Some sub-processors store or process data outside Egypt, including in the European Union and the United States, and the company agrees to those transfers. Integr8 and the company each take the steps Egyptian law requires of them for those transfers, and Integr8 helps the company with any licence or permit it needs from the Personal Data Protection Center.',
      },
      assistance: {
        title: 'Helping the company',
        body:
          'Integr8 helps the company meet its own obligations:\n' +
          '- requests from individuals: most can be handled in the apps, by finding, correcting, exporting or deleting records; where they cannot, Integr8 helps, and passes on any request it receives directly;\n' +
          '- assessments of the risks to personal data, and questions from the regulator, with the information Integr8 holds about how the service works;\n' +
          '- a complete export of the company’s data, on request.',
      },
      breaches: {
        title: 'Security breaches',
        body: 'If Integr8 becomes aware of a breach affecting company personal data, it tells the company without undue delay, with what is known: what happened, which data and people are affected, what Integr8 has done, and what it recommends. Integr8 then keeps the company informed, so that the company can notify the Personal Data Protection Center and the people affected within the time the law allows.',
      },
      audits: {
        title: 'Information and audits',
        body: 'Integr8 gives the company the information it reasonably needs to show that these terms are being met, and answers its questions about security. If that is not enough, or the regulator requires it, the company may have an audit carried out, on reasonable notice and with confidentiality agreed, at most once a year unless there has been a breach.',
      },
      ending: {
        title: 'When the agreement ends',
        body: 'Integr8 makes a complete export of the company’s data, which the company can download for thirty days. Seven days after the company’s account is closed, Integr8 permanently deletes the company’s data from the service, including its files and its people’s sign-in accounts, unless they belong to another company on Integr8 Plus. Copies in backups are deleted as the backups are replaced. Integr8 keeps only what the law requires it to keep, and the record of what its staff did on the account.',
      },
      company: {
        title: 'The company’s responsibilities',
        body:
          'The company is responsible for:\n' +
          '- having a lawful basis for the personal data it puts in, and telling the people concerned what it records, for example telling its engineers that the phone records where each form is submitted;\n' +
          '- what its forms ask for, collecting no more than it needs;\n' +
          '- who it gives accounts to, and what it lets each person do;\n' +
          '- the accuracy of its data, and answering the requests it receives from individuals.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions about these terms: {{email}}. Integr8’s details are below.',
      },
    },
  },
} as const;
