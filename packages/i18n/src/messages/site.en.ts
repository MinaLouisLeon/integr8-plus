/**
 * The public site, in English: home, features, pricing, help, download, and
 * the frame around them (Low 3, the Integr8 Media look). Arabic is in
 * `site.ar.ts`; the parity test in this folder checks the two agree.
 *
 * Written from what the product does today (README "What it does", the
 * modules in MEMORY.md), without superlatives or invented numbers. A line here
 * that stops being true is a bug in the product or a lie on the page. The
 * features are fifteen, in the order the page shows them; `tag` is the group
 * each belongs to.
 */
export const siteEn = {
  brand: {
    integr8Media: 'Integr8 Media',
    byIntegr8Media: 'By Integr8 Media',
    integr8MediaTitle: 'Integr8 Media, the company behind Integr8 Plus',
    home: 'Integr8 Plus, home',
  },
  nav: {
    main: 'Main',
    features: 'Features',
    pricing: 'Pricing',
    help: 'Help',
    download: 'Download',
    signIn: 'Sign in',
    menu: 'Open the menu',
    closeMenu: 'Close the menu',
    language: 'Language',
  },
  footer: {
    tagline:
      'Field operations for service companies: the phone that works with no signal, and the office that sees the result.',
    product: 'Product',
    legal: 'Legal',
    company: 'Company',
    staff: 'Integr8 staff',
    copyright: '© {{year}} Integr8 Media. All rights reserved.',
  },
  home: {
    eyebrow: 'Field operations, offline first',
    metaStart: 'Work orders · Forms · Business',
    metaEnd: 'English · العربية',
    titleLine1: 'Every job, every form,',
    titleGradient: 'one platform.',
    subtitle:
      'Integr8 Plus runs a service company from the first call to the signed certificate: the office plans the work, engineers do it on a phone that keeps working with no signal, and the result is in the office the moment the phone has signal again.',
    secondaryCta: 'See what it does',
    modulesLabel: 'What is inside',
    modules: {
      workOrders: 'Work orders',
      schedule: 'Schedule',
      forms: 'Forms',
      crm: 'CRM',
      sales: 'Sales',
      inventory: 'Inventory',
      purchasing: 'Purchasing',
      assets: 'Assets',
      finance: 'Finance',
      ledger: 'Ledger',
      hr: 'HR',
      payroll: 'Payroll',
      manufacturing: 'Manufacturing',
      documents: 'Documents',
      eInvoicing: 'E-invoicing',
    },
    appsEyebrow: 'How it fits together',
    appsTitle: 'Three apps.',
    appsTitleOutline: 'One company.',
    appsSubtitle:
      'Each company gets its own apps with its own name, icon and colours. Its people sign in to them and nobody else does.',
    apps: {
      officeTitle: 'The office',
      officeBody:
        'In the browser or the company’s own desktop app: customers and sites, work orders and the schedule, submissions, stock, money and people.',
      officeTags: 'Web · Windows · macOS · Linux',
      fieldTitle: 'The engineers',
      fieldBody:
        'The company’s own phone app: today’s jobs, directions and access notes, forms, photos and signatures. It keeps an encrypted copy of the work and syncs when there is signal.',
      fieldTags: 'Android · iPhone · Offline',
      integr8Title: 'Integr8',
      integr8Body:
        'We set the company up: its forms and job types from its own paperwork, its look, its apps, and the modules it needs. Then we stay on hand.',
      integr8Tags: 'Set-up · Support · Updates',
    },
    stepsEyebrow: 'Getting started',
    stepsTitle: 'From paper to the phone',
    steps: {
      oneTitle: 'Tell us how you work',
      oneBody: 'The kinds of jobs you do, the paperwork your engineers fill in, and who does what.',
      twoTitle: 'We build your forms',
      twoBody:
        'Your job sheets, checks and certificates become forms and job types, in English and Arabic.',
      threeTitle: 'Your apps, your name',
      threeBody:
        'Desktop and phone apps with your logo and colours, and your people invited to them.',
      fourTitle: 'Go live, then grow',
      fourBody:
        'Start with the field work. Switch on sales, stock, finance or payroll when you are ready.',
    },
    highlightsEyebrow: 'Highlights',
    highlightsTitle: 'Built for the work, not the demo',
    allFeatures: 'All fifteen features',
    ctaEyebrow: 'Contact',
    ctaTitle: 'Let’s integr8',
    ctaBody:
      'There is no sign-up form. Tell us about your company and we will set it up with you, ready to use on the first day.',
  },
  features: {
    eyebrow: 'Features',
    title: 'Everything it does,',
    titleGradient: 'in plain words.',
    subtitle:
      'Fifteen things Integr8 Plus does today. The business modules are switched on per company, so each one sees only what it uses.',
    groups: {
      field: 'Field',
      office: 'Office',
      business: 'Business',
      platform: 'Platform',
    },
    items: {
      offline: {
        title: 'Works with no signal',
        body: 'The phone keeps an encrypted copy of the engineer’s work and every screen reads from it. What is done offline is sent when there is signal, exactly once and in order, and the app opens for seven days with no network at all.',
      },
      workOrders: {
        title: 'Work orders, start to sign-off',
        body: 'From scheduled to travelling, on site, complete and reviewed, with a crew and its lead, a checklist, photos before and after, the customer’s signature and a full history.',
      },
      schedule: {
        title: 'Schedule, visits and skills',
        body: 'A job can take several visits, planned by day or week for each engineer, and nobody can be booked on two jobs at once. Record the certificates people hold and get warned before one expires.',
      },
      forms: {
        title: 'Your forms, built for you',
        body: 'Eighteen kinds of question, pages and repeatable sections, calculations, and questions that appear only when an answer calls for them. A published version never changes.',
      },
      submissions: {
        title: 'Submissions you can trust',
        body: 'Saved as they are filled, checked again by the server, and corrected only with a reason. Every version is kept, so a certificate reads the way it was signed.',
      },
      customers: {
        title: 'Customers, sites and assets',
        body: 'Contacts and account status, sites with gate codes and hazards shown first on every job, and the customer’s equipment with its tag, warranty and service history.',
      },
      contracts: {
        title: 'Contracts, maintenance and deadlines',
        body: 'Record what each customer is covered for, let maintenance plans create servicing jobs ahead of time, and watch response deadlines count down with warnings before they are missed.',
      },
      crm: {
        title: 'Leads, quotes and sales',
        body: 'Pipelines and opportunities, follow-ups, and quotes the customer accepts from a link. An accepted quote becomes a sales order that reserves stock and records each delivery.',
      },
      inventory: {
        title: 'Stock and purchasing',
        body: 'Items, locations, counts, serial and batch numbers, van stock and the parts used on each job, with suppliers, purchase orders, receipts and reorder suggestions.',
      },
      finance: {
        title: 'Invoices and the ledger',
        body: 'Invoices, payments, credit notes and the cost of each job, posted to a management ledger with journals, periods and reports. A management tool, not a statutory one.',
      },
      people: {
        title: 'People, expenses and payroll',
        body: 'Employee records, expense claims with receipts, Egyptian payroll rules, pay runs and payslips, with access to personal details limited to the people who need it.',
      },
      documents: {
        title: 'Documents and e-invoicing',
        body: 'Printable quotes, invoices and certificates from your own templates, each with a QR code that opens it. Egyptian Tax Authority e-invoicing is built and in testing.',
      },
      assistant: {
        title: 'An assistant, if you want one',
        body: 'Answers from the help library in English or Arabic, and questions about your own business within each person’s permissions. It acts only after a person confirms. Off until switched on.',
      },
      branding: {
        title: 'Your name on every app',
        body: 'Your own desktop and phone apps with your logo, icon and colours, which only your people can sign in to. English and Arabic, right to left included.',
      },
      data: {
        title: 'Your data, accounted for',
        body: 'Roles and permissions for every person, a history of every change, storage you can see, and an export of everything whenever you ask. Hosted on Integr8’s own servers.',
      },
    },
  },
  pricing: {
    eyebrow: 'Pricing',
    title: 'Plans that',
    titleGradient: 'grow with you.',
    included: 'In every plan',
    includedItems: {
      apps: 'Your own desktop and phone apps',
      offline: 'The phone app that works with no signal',
      languages: 'English and Arabic, right to left included',
      setup: 'Set-up by Integr8: your forms, job types and look',
      export: 'An export of everything, whenever you ask',
    },
    modulesNote:
      'Business modules (CRM, sales, finance, ledger, inventory, purchasing, assets, HR, payroll, manufacturing, documents and e-invoicing) are switched on per company. Ask us which fit yours.',
  },
  help: {
    eyebrow: 'Help centre',
    title: 'Answers,',
    titleGradient: 'in plain words.',
    subtitle:
      'How Integr8 Plus works, written as the questions people ask. Every answer is on this page.',
    search: 'Search the answers',
    searchPlaceholder: 'Try “offline” or “invite”',
    categories: 'Topics',
    noMatch: 'Nothing matches “{{query}}”. Try another word, or ask us.',
    stillStuck: 'Still stuck?',
    stillStuckBody: 'Write to us and a person answers, in English or Arabic.',
  },
  contact: {
    eyebrow: 'Getting set up',
  },
  auth: {
    staffEyebrow: 'Integr8 staff',
    peopleEyebrow: 'Sign in',
  },
  download: {
    eyebrow: 'Download',
    title: 'Get the',
    titleGradient: 'apps.',
    subtitle:
      'Each company has its own desktop and phone apps, with its name and colours. Open this page from your company’s app, or from the link your administrator sent, to see your company’s files.',
    lookup: {
      label: 'Your company’s short name',
      hint: 'The name in your company’s link, for example “acme”.',
      submit: 'Show my apps',
    },
    company: {
      title: 'Apps for {{company}}',
      version: 'Version {{version}}',
      desktop: 'Desktop app',
      phone: 'Phone app',
      notFound:
        'We could not find apps for “{{company}}”. Check the name, or ask your company’s administrator for the right link.',
      noRelease:
        'Your company’s apps have not been published yet. Ask your company’s administrator when they will be.',
      phoneSent:
        'Your company sends you the phone app. Ask your administrator for the invitation or the store link.',
      phoneAndroid:
        'Android phones can install this file. On iPhone, your company sends you the app.',
      updatesNote:
        'Already installed? The desktop app updates itself. This page is for a first install, or an update the app could not make on its own.',
    },
    staff: {
      title: 'Integr8 Plus Staff',
      body: 'For Integr8’s own team: set up companies, build their forms and job types, and look after their branding.',
      none: 'No staff release has been published yet.',
    },
    formsAi: {
      title: 'Integr8 Forms for AI',
      body: 'For Integr8’s own team: lets AI coding tools such as Claude Code, Codex, Cursor or VS Code build forms and PDF templates as .integr8form files, offline. Download the file for your computer, double-click it, tick your AI tools, then ask your AI to build a form.',
      program: 'Program, one file',
      warning:
        'Not signed: Windows and macOS warn when it is first opened. On a Mac, right-click it and choose Open.',
    },
    general: {
      companyDesktopTitle: 'Your company’s desktop app',
      companyDesktopBody:
        'For the office, on Windows, macOS or Linux, with your company’s name and colours. Enter your company’s short name above to see its installers.',
      phoneTitle: 'Your company’s phone app',
      phoneBody:
        'For engineers, on Android and iPhone, and it works with no signal. Your company sends it to you; Android files are also listed here once your company is chosen.',
    },
    unavailable:
      'The downloads cannot be listed right now. Try again in a few minutes, or ask your administrator.',
    platforms: {
      windows: 'Windows',
      macos: 'macOS',
      linux: 'Linux',
      android: 'Android',
    },
    kinds: {
      exe: 'Installer (.exe)',
      msi: 'Windows Installer (.msi)',
      dmg: 'Disk image (.dmg)',
      appimage: 'AppImage, any Linux',
      deb: 'Debian and Ubuntu (.deb)',
      rpm: 'Fedora and Red Hat (.rpm)',
      apk: 'Android app (.apk)',
    },
    architecture: {
      x64: 'Intel and AMD, 64-bit',
      arm64: 'ARM, 64-bit',
      universal: 'Apple silicon and Intel',
    },
    file: 'Download {{name}}',
  },
} as const;
