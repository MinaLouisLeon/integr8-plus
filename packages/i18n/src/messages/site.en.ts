/**
 * The public site, in English: help, contact, the frame around them (Low 3,
 * the Integr8 Media look), and the installer list that accepting an
 * invitation shows (`download`, whose staff entries the staff app's Downloads
 * screen uses). Arabic is in `site.ar.ts`; the parity test in this folder
 * checks the two agree.
 *
 * Written from what the product does today, without superlatives or invented
 * numbers. A line here that stops being true is a bug in the product or a lie
 * on the page. The product's own story is on the Integr8 Media website.
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
    help: 'Help',
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
    company: {
      title: 'Apps for {{company}}',
      version: 'Version {{version}}',
      desktop: 'Desktop app',
      phone: 'Phone app',
      noRelease:
        'Your company’s apps have not been published yet. Ask your company’s administrator when they will be.',
      phoneSent:
        'Your company sends you the phone app. Ask your administrator for the invitation or the store link.',
      phoneAndroid:
        'Android phones can install this file. On iPhone, your company sends you the app.',
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
    devMcp: {
      title: 'Integr8 developer MCP server',
      body: 'For Integr8’s developers: lets AI coding tools try features on a running API in test companies, build a company’s website against its documents, and build forms like Forms for AI. Unzip the file for your computer into one folder, double-click the program, tick your AI tools and sign in with your staff account.',
      program: 'Program and keychain module, one zip',
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
