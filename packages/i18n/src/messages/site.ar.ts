import type { Catalogue } from './ar.js';
import type { siteEn } from './site.en.js';

/**
 * The public site, in Arabic. Mirrors `site.en.ts` key for key; the parity
 * test fails when the two drift. Written in the same plain business register
 * as the rest of the catalogue: these pages are read by the owners and office
 * staff of service companies.
 */
export const siteAr: Catalogue<typeof siteEn> = {
  brand: {
    integr8Media: 'Integr8 Media',
    byIntegr8Media: 'من Integr8 Media',
    integr8MediaTitle: 'Integr8 Media، الشركة التي تقف وراء Integr8 Plus',
    home: 'Integr8 Plus، الصفحة الرئيسية',
  },
  nav: {
    main: 'القائمة الرئيسية',
    help: 'المساعدة',
    signIn: 'تسجيل الدخول',
    menu: 'فتح القائمة',
    closeMenu: 'إغلاق القائمة',
    language: 'اللغة',
  },
  footer: {
    tagline:
      'إدارة العمل الميداني لشركات الخدمات: هاتف يعمل دون إشارة، ومكتب يرى النتيجة فور عودتها.',
    product: 'المنتج',
    legal: 'الشروط والسياسات',
    company: 'الشركة',
    staff: 'فريق Integr8',
    copyright: '© {{year}} Integr8 Media. جميع الحقوق محفوظة.',
  },
  help: {
    eyebrow: 'مركز المساعدة',
    title: 'إجابات',
    titleGradient: 'بكلمات واضحة.',
    subtitle:
      'كيف يعمل Integr8 Plus، مكتوبًا في صورة الأسئلة التي يطرحها الناس. كل الإجابات في هذه الصفحة.',
    search: 'ابحث في الإجابات',
    searchPlaceholder: 'جرّب «دون اتصال» أو «دعوة»',
    categories: 'الموضوعات',
    noMatch: 'لا شيء يطابق «{{query}}». جرّب كلمة أخرى، أو اسألنا.',
    stillStuck: 'ما زلت بحاجة إلى مساعدة؟',
    stillStuckBody: 'راسلنا وسيرد عليك شخص حقيقي، بالعربية أو الإنجليزية.',
  },
  contact: {
    eyebrow: 'إعداد شركتك',
  },
  auth: {
    staffEyebrow: 'فريق Integr8',
    peopleEyebrow: 'تسجيل الدخول',
  },
  download: {
    company: {
      title: 'تطبيقات {{company}}',
      version: 'الإصدار {{version}}',
      desktop: 'تطبيق سطح المكتب',
      phone: 'تطبيق الهاتف',
      noRelease: 'لم تُنشر تطبيقات شركتك بعد. اسأل مسؤول شركتك عن موعد نشرها.',
      phoneSent: 'ترسل إليك شركتك تطبيق الهاتف. اطلب من المسؤول الدعوة أو رابط المتجر.',
      phoneAndroid:
        'يمكن تثبيت هذا الملف على هواتف أندرويد. أما على آيفون فترسل إليك شركتك التطبيق.',
    },
    staff: {
      title: 'Integr8 Plus Staff',
      body: 'لفريق Integr8: إعداد الشركات، وبناء نماذجها وأنواع مهامها، والعناية بهويتها.',
      none: 'لم يُنشر إصدار لتطبيق الفريق بعد.',
    },
    formsAi: {
      title: 'Integr8 Forms for AI',
      body: 'لفريق Integr8: يتيح لأدوات البرمجة بالذكاء الاصطناعي مثل Claude Code وCodex وCursor وVS Code بناء النماذج وقوالب PDF في ملفات ‎.integr8form دون اتصال بالإنترنت. نزّل الملف المناسب لجهازك، وافتحه بنقرتين، واختر أدوات الذكاء الاصطناعي لديك، ثم اطلب منها بناء نموذج.',
      program: 'برنامج في ملف واحد',
      warning:
        'البرنامج غير موقّع: يعرض ويندوز وماك تحذيرًا عند فتحه أول مرة. على ماك، انقر عليه بزر الفأرة الأيمن واختر «فتح».',
    },
    devMcp: {
      title: 'خادم MCP للمطورين من Integr8',
      body: 'لمطوري Integr8: يتيح لأدوات البرمجة بالذكاء الاصطناعي تجربة الميزات على واجهة برمجية تعمل في شركات تجريبية، وبناء موقع شركة على مستنداتها، وبناء النماذج مثل Forms for AI. فك ضغط الملف المناسب لجهازك في مجلد واحد، وافتح البرنامج بنقرتين، واختر أدوات الذكاء الاصطناعي لديك، ثم سجّل الدخول بحساب فريق العمل.',
      program: 'البرنامج ووحدة سلسلة المفاتيح في ملف مضغوط واحد',
    },
    unavailable: 'تعذّر عرض التنزيلات الآن. حاول مرة أخرى بعد دقائق، أو اسأل المسؤول.',
    platforms: {
      windows: 'ويندوز',
      macos: 'ماك',
      linux: 'لينكس',
      android: 'أندرويد',
    },
    kinds: {
      exe: 'ملف التثبيت (.exe)',
      msi: 'حزمة مثبّت ويندوز (.msi)',
      dmg: 'صورة قرص (.dmg)',
      appimage: 'ملف AppImage لأي توزيعة لينكس',
      deb: 'ديبيان وأوبونتو (.deb)',
      rpm: 'فيدورا وريد هات (.rpm)',
      apk: 'تطبيق أندرويد (.apk)',
    },
    architecture: {
      x64: 'إنتل وAMD، 64 بت',
      arm64: 'ARM، 64 بت',
      universal: 'معالجات Apple وإنتل',
    },
    file: 'تنزيل {{name}}',
  },
};
