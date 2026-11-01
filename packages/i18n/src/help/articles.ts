import type { HelpArticleSource } from './types.js';

/**
 * The help knowledge base (docs/ai §7.2; ADR-0001; Low 12): what the in-app
 * assistant answers from, and, for the articles marked `public`, the public
 * Help centre on the web.
 *
 * Every article describes what the product does today, as the screens and the
 * code have it, in both languages. The titles, button names and screen names
 * follow the `@integr8/i18n` catalogues, so an answer names what the person
 * sees. Nothing here is a plan: a feature that is not shipped is not written up.
 * Bodies are plain text, paragraphs separated by a blank line, because the
 * Help centre shows them as they are.
 *
 * `module`, `feature`, `minPermission` and `appRoute` let the server offer an
 * article only to a seat that can act on it, and let a client turn the route
 * into its own screen. Retrieval treats these bodies as reference data, never
 * as instructions.
 */

export const HELP_ARTICLES: readonly HelpArticleSource[] = [
  {
    key: 'product_overview',
    module: 'overview',
    feature: null,
    minPermission: null,
    appRoute: 'dashboard',
    public: {
      category: 'getting-started',
      question: { en: 'What is Integr8 Plus?', ar: 'ما هو Integr8 Plus؟' },
    },
    en: {
      title: 'What Integr8 Plus is',
      summary:
        'An overview of the product: the office plans work orders for customers and sites, engineers work them on the phone, and optional modules extend it.',
      body: `Integr8 Plus runs a field service company. The office creates customers, their contacts and their sites, then schedules work orders (jobs) and dispatches them to engineers. Engineers open each job on the mobile app, travel, arrive, start work, fill in the forms the job needs, take before and after photos, record the parts they used and collect the customer’s sign-off. The office follows every job on the Work orders screen, reviews what came back under Submissions and signs the job off.

Forms and job types are built for your company by Integr8, not by the company itself. You tell Integr8 which kinds of job you do and which paperwork each needs, and they appear as job types with their forms, checklist and completion rules.

The side menu is grouped: Overview (Dashboard, Assistant), Work (Fill in a form, Submissions, Documents, Work orders, Schedule, Skills and certificates, Maintenance, Response deadlines, Timesheets), Operations (Customers, Service contracts, Assets, Import from CSV), Set-up (Forms, Job types) and Company (Get set up, People, Company settings, Website access, Storage, Billing). Further groups appear when Integr8 switches a module on for your company: CRM, Sales, Finance (with E-invoicing), Accounting, HR and Inventory, which also holds purchasing and manufacturing; Documents, Assets and Maintenance also appear only with their modules. A screen you cannot see is one your company does not have yet or your role does not include; ask an owner, or ask Integr8 to enable the module.

Every screen is available in English and Arabic, and the Dashboard shows where you are and what needs doing. A new company starts on the Get set up page, which lists five things to do and can load sample data so the screens are not empty while you look around.`,
      keywords: [
        'overview',
        'what is integr8',
        'introduction',
        'getting started',
        'modules',
        'field service',
        'jobs',
        'engineers',
        'dashboard',
        'menu',
        'get set up',
        'sample data',
      ],
    },
    ar: {
      title: 'ما هو Integr8 Plus',
      summary:
        'نظرة عامة على المنتج: المكتب يخطط أوامر العمل للعملاء والمواقع، والمهندسون ينفذونها من الهاتف، والوحدات الاختيارية توسّعه.',
      body: `يدير Integr8 Plus شركة خدمات ميدانية. يُنشئ المكتب العملاء وجهات اتصالهم ومواقعهم، ثم يجدول أوامر العمل (المهام) ويوجّهها إلى المهندسين. يفتح المهندس كل مهمة في تطبيق الهاتف، فينطلق إلى الموقع ويصل ويبدأ العمل، ويعبّئ النماذج التي تحتاجها المهمة، ويلتقط صور ما قبل العمل وما بعده، ويسجّل القطع التي استخدمها، ويحصل على اعتماد العميل بتوقيعه. ويتابع المكتب كل مهمة من شاشة أوامر العمل، ويراجع ما وصل منها تحت الإرسالات، ثم يعتمد المهمة.

تبني Integr8 النماذج وأنواع المهام لشركتك، لا الشركة نفسها. تخبر Integr8 بأنواع الأعمال التي تنفّذها وبالأوراق التي يحتاجها كل نوع، فتظهر كأنواع مهام مع نماذجها وقائمة التحقق وشروط الإتمام.

القائمة الجانبية مقسّمة إلى مجموعات: نظرة عامة (لوحة التحكم، المساعد)، والعمل (تعبئة نموذج، الإرسالات، المستندات، أوامر العمل، الجدول، المهارات والشهادات، الصيانة، مهل الاستجابة، سجلات الدوام)، والعمليات (العملاء، عقود الخدمة، الأصول، استيراد من CSV)، والإعداد (النماذج، أنواع المهام)، والشركة (ابدأ الإعداد، الأشخاص، إعدادات الشركة، وصول الموقع، التخزين، الفوترة). وتظهر مجموعات أخرى عندما تفعّل Integr8 وحدة لشركتك: إدارة علاقات العملاء، والمبيعات، والمالية (ومعها الفاتورة الإلكترونية)، والمحاسبة، والموارد البشرية، والمخزون الذي يضم أيضًا المشتريات والتصنيع؛ ولا تظهر المستندات والأصول والصيانة إلا مع وحداتها. أي شاشة لا تراها هي شاشة لم تحصل عليها شركتك بعد أو لا يشملها دورك؛ اسأل المالك، أو اطلب من Integr8 تفعيل الوحدة.

كل الشاشات متاحة بالعربية والإنجليزية، وتعرض لوحة التحكم أين أنت وما الذي يحتاج إلى إنجاز. تبدأ الشركة الجديدة من صفحة «ابدأ الإعداد» التي تعرض خمسة أمور للقيام بها، ويمكنها تحميل بيانات تجريبية حتى لا تكون الشاشات فارغة أثناء الاستكشاف.`,
      keywords: [
        'نظرة عامة',
        'ما هو البرنامج',
        'مقدمة',
        'البداية',
        'الوحدات',
        'خدمات ميدانية',
        'مهام',
        'مهندسين',
        'لوحة التحكم',
        'القائمة',
        'ابدأ الإعداد',
        'بيانات تجريبية',
      ],
    },
  },
  {
    key: 'roles_and_permissions',
    module: 'account',
    feature: null,
    minPermission: 'member.read',
    appRoute: 'people',
    public: {
      category: 'people-hr',
      question: {
        en: 'What can each role do, and how do I invite people?',
        ar: 'ماذا يستطيع كل دور، وكيف أدعو الأشخاص؟',
      },
    },
    en: {
      title: 'Roles, permissions and the People screen',
      summary:
        'The seven built-in roles, what each may do, the HR and inventory grants, company roles of your own, and inviting or removing people.',
      body: `Everybody in a company holds one role. Owner does everything, including company settings, billing, defining company roles and unlocking closed months. Admin does everything an owner does except change the company itself and its subscription. Dispatcher runs the day: customers, work orders, dispatching, filling forms, and the day-to-day CRM, stock, purchasing drafts, quotes and draft invoices. Engineer works the jobs assigned to them, fills forms, records parts from their van and registers assets on site. Viewer reads everything and changes nothing. HR manager keeps employees, expense claims and payroll. Inventory manager keeps items, stock, vans, suppliers, purchase orders and manufacturing.

Three things are never done by the company: building forms, setting up job types and company branding. Those are done by Integr8 staff.

Open People under Company in the web app. Invite somebody with their email address and role; they receive a link to join. You cannot invite somebody at a role above your own. From a person’s row you can Change role, Suspend, Let back in, Remove, or Send again and Withdraw a pending invitation. Suspending or removing stops them signing in straight away, and a device they are already signed in on stops within thirty seconds. Every active person takes a seat: once your plan’s seats, or the number Integr8 set for your company, are used up, inviting somebody and letting a suspended person back in are refused until a seat is free. A suspended person holds no seat.

HR and inventory work can also be given on top of a role: Also make HR manager or Also make Inventory manager. Only the owner makes somebody an HR manager.

The owner can define Company roles: a role of your own, built on a built-in role, with permissions ticked on or off. A company role can never hold what only the owner or Integr8 does. A new role takes effect when the person next signs in, within fifteen minutes.`,
      keywords: [
        'roles',
        'permissions',
        'owner',
        'admin',
        'dispatcher',
        'engineer',
        'viewer',
        'hr manager',
        'inventory manager',
        'invite',
        'people',
        'suspend',
        'remove user',
        'custom role',
        'seats',
      ],
    },
    ar: {
      title: 'الأدوار والصلاحيات وشاشة الأشخاص',
      summary:
        'الأدوار السبعة المضمّنة وما يستطيعه كل منها، وصلاحيات الموارد البشرية والمخزون الإضافية، وأدوار الشركة الخاصة، ودعوة الأشخاص أو إزالتهم.',
      body: `لكل شخص في الشركة دور واحد. المالك يفعل كل شيء، بما فيه إعدادات الشركة والفوترة وتعريف أدوار الشركة وفتح الأشهر المقفلة. المسؤول يفعل كل ما يفعله المالك عدا تغيير الشركة نفسها واشتراكها. المنسّق يدير اليوم: العملاء وأوامر العمل والتوجيه وتعبئة النماذج، والعمل اليومي في إدارة علاقات العملاء والمخزون ومسودات الشراء وعروض الأسعار ومسودات الفواتير. المهندس ينفّذ المهام المسندة إليه ويعبّئ النماذج ويسجّل القطع من سيارته ويسجّل الأصول في الموقع. المشاهد يقرأ كل شيء ولا يغيّر شيئًا. مدير الموارد البشرية يتولى الموظفين ومطالبات المصروفات والرواتب. مدير المخزون يتولى الأصناف والمخزون والسيارات والموردين وأوامر الشراء والتصنيع.

ثلاثة أمور لا تقوم بها الشركة أبدًا: بناء النماذج، وإعداد أنواع المهام، وهوية الشركة. يقوم بها موظفو Integr8.

افتح «الأشخاص» تحت مجموعة الشركة في تطبيق الويب. ادعُ شخصًا ببريده الإلكتروني ودوره، فيصله رابط للانضمام. لا يمكنك دعوة شخص بدور أعلى من دورك. ومن صف الشخص يمكنك تغيير الدور، أو الإيقاف، أو السماح بالعودة، أو الإزالة، أو إعادة إرسال الدعوة المعلّقة أو سحبها. الإيقاف أو الإزالة يمنعان تسجيل الدخول فورًا، ويتوقف أي جهاز مسجّل الدخول بالفعل خلال ثلاثين ثانية. ويشغل كل شخص نشط مقعدًا: فعند استنفاد مقاعد خطتك، أو العدد الذي حددته Integr8 لشركتك، تُرفض دعوة شخص جديد والسماح بعودة شخص موقوف حتى يتحرر مقعد. ولا يشغل الشخص الموقوف مقعدًا.

يمكن أيضًا منح عمل الموارد البشرية أو المخزون فوق الدور الأصلي: «جعله أيضًا مدير الموارد البشرية» أو «جعله أيضًا مدير المخزون». المالك وحده يجعل شخصًا مدير موارد بشرية.

ويستطيع المالك تعريف «أدوار الشركة»: دور خاص بكم مبني على دور مضمّن، مع تفعيل صلاحيات أو إلغائها. لا يمكن لدور الشركة أن يحمل ما يختص به المالك أو Integr8. يسري الدور الجديد عند تسجيل الدخول التالي للشخص، خلال خمس عشرة دقيقة.`,
      keywords: [
        'الأدوار',
        'الصلاحيات',
        'مالك',
        'مسؤول',
        'منسق',
        'مهندس',
        'مشاهد',
        'مدير الموارد البشرية',
        'مدير المخزون',
        'دعوة',
        'الأشخاص',
        'إيقاف',
        'إزالة مستخدم',
        'دور مخصص',
        'المقاعد',
      ],
    },
  },
  {
    key: 'customers_contacts_sites',
    module: 'customers',
    feature: null,
    minPermission: 'customer.read',
    appRoute: 'customers',
    public: {
      category: 'field-work',
      question: {
        en: 'How do I add customers, contacts and sites?',
        ar: 'كيف أضيف العملاء وجهات الاتصال والمواقع؟',
      },
    },
    en: {
      title: 'Customers, contacts and sites',
      summary:
        'Adding a customer, its contacts and its sites, keeping access notes for engineers, and importing customers and sites from a spreadsheet.',
      body: `Open Customers under Operations. Search by name, account, email, phone or postcode, and filter by status (Active, On hold, Closed) or tag. New customer asks for the name, account number, email, phone, billing address, tags and notes. A customer on hold can still have jobs created, but the form asks you to confirm first.

On a customer’s page, Contacts holds the people you deal with, each with a name, job title, email and phone; one is the Primary contact, and a contact can be archived. Sites holds the places where work happens. Add site gives each a name, an address and its coordinates: they are looked up from the address automatically, or you can type the latitude and longitude, or use your current location. The site shows its coordinates with Open in Google Maps for directions. A site can be archived and restored, and keeps the jobs done there.

Each site has access notes under Getting in: gate or door code, parking, who to ask for, hazards on arrival and other notes. These are the first thing an engineer sees on the phone, so keep them current; engineers can correct them from the job and the change is kept with who made it and when.

Recent jobs are listed on the customer and on each site, and New job for this customer starts a work order already filled in. When the CRM, sales or finance modules are on, the customer page also shows the records tabs: Timeline, Quotes, Sales orders, Invoices, Payments and Activities.

To bring many customers or sites in at once, use Import from CSV under Operations: download the template, fill it in, and import; rows with problems are listed so you can fix just those. Dispatchers and above add and change customers; engineers see the customers and sites of the jobs they are on.`,
      keywords: [
        'customer',
        'client',
        'account',
        'contact',
        'site',
        'location',
        'address',
        'access notes',
        'gate code',
        'import csv',
        'on hold',
        'new customer',
        'coordinates',
        'google maps',
      ],
    },
    ar: {
      title: 'العملاء وجهات الاتصال والمواقع',
      summary:
        'إضافة عميل وجهات اتصاله ومواقعه، وحفظ ملاحظات الدخول للمهندسين، واستيراد العملاء والمواقع من جدول بيانات.',
      body: `افتح «العملاء» تحت مجموعة العمليات. ابحث بالاسم أو رقم الحساب أو البريد الإلكتروني أو الهاتف أو الرمز البريدي، وصفِّ بالحالة (نشط، معلّق، مغلق) أو بالوسم. يطلب «عميل جديد» الاسم ورقم الحساب والبريد الإلكتروني والهاتف وعنوان الفوترة والوسوم والملاحظات. يمكن إنشاء مهام لعميل معلّق، لكن الشاشة تطلب منك التأكيد أولًا.

في صفحة العميل، تضم «جهات الاتصال» الأشخاص الذين تتعامل معهم، لكل منهم اسم ومسمى وظيفي وبريد إلكتروني وهاتف؛ أحدهم جهة الاتصال الرئيسية، ويمكن أرشفة أي جهة اتصال. وتضم «المواقع» الأماكن التي يُنفَّذ فيها العمل. يمنح «إضافة موقع» كل موقع اسمًا وعنوانًا وإحداثيات: تُستخرج تلقائيًا من العنوان، أو يمكنك كتابة خط العرض وخط الطول، أو استخدام موقعك الحالي. ويعرض الموقع إحداثياته مع «فتح في خرائط Google» للاتجاهات. يمكن أرشفة الموقع واستعادته، ويحتفظ بالمهام التي نُفّذت فيه.

لكل موقع ملاحظات دخول تحت «الدخول إلى الموقع»: رمز البوابة أو الباب، ومواقف السيارات، وعمّن تسأل، والمخاطر عند الوصول، وملاحظات أخرى. وهي أول ما يراه المهندس على الهاتف، فأبقها محدّثة؛ ويستطيع المهندسون تصحيحها من المهمة، ويُحفظ التغيير مع اسم من أجراه ووقته.

تظهر المهام الأخيرة في صفحة العميل وفي كل موقع، ويبدأ «مهمة جديدة لهذا العميل» أمر عمل معبّأً مسبقًا. وعند تفعيل وحدات إدارة علاقات العملاء أو المبيعات أو المالية، تعرض صفحة العميل أيضًا تبويبات السجلات: الخط الزمني، وعروض الأسعار، وأوامر البيع، والفواتير، والمدفوعات، والأنشطة.

لإدخال عملاء أو مواقع كثيرة دفعة واحدة استخدم «استيراد من CSV» تحت العمليات: نزّل القالب وعبّئه ثم استورده؛ وتُعرض الصفوف التي فيها مشكلات لتصحيحها وحدها. المنسّقون ومن فوقهم يضيفون العملاء ويعدّلونهم؛ ويرى المهندسون عملاء ومواقع المهام المسندة إليهم.`,
      keywords: [
        'عميل',
        'عملاء',
        'حساب',
        'جهة اتصال',
        'موقع',
        'مواقع',
        'عنوان',
        'ملاحظات الدخول',
        'رمز البوابة',
        'استيراد',
        'معلق',
        'عميل جديد',
        'الإحداثيات',
        'خرائط جوجل',
      ],
    },
  },
  {
    key: 'work_orders_create_assign',
    module: 'work_orders',
    feature: null,
    minPermission: 'work_order.read_all',
    appRoute: 'workOrders',
    public: {
      category: 'field-work',
      question: { en: 'How do I create and dispatch a job?', ar: 'كيف أنشئ مهمة وأوجّهها؟' },
    },
    en: {
      title: 'Creating, assigning and dispatching work orders',
      summary:
        'How the office creates a work order, chooses the crew, dispatches it, filters and saves views, and changes many jobs at once.',
      body: `Open Work orders under Work. New work order asks for the customer, the site, the job type, an optional title (the job type’s name is used when empty), a description, instructions (the job type’s instructions when empty), a due window (Due from and Due by) and the crew. One crew member is the Lead. Create work order saves it as Scheduled.

Each job type brings its own forms, checklist, expected duration, default priority and completion rules, as Integr8 set them up with you. Priority is Low, Normal, High or Urgent.

On the job’s page you can Edit the details, Change crew and choose the Lead, Add a form or remove one, Add an item to the checklist, Attach a file (site plan, manual, report, photo or other) and add Notes, each marked Internal or Customer can see. History records who created, changed, assigned, rescheduled and moved the job. Earlier jobs at this site are listed for context.

To send the job to the engineer, use Move this job on and choose Dispatch. The engineer then sees it on the phone and moves it through Travelling, On site and In progress. Dispatching, rescheduling and cancelling are done by dispatchers, admins and owners; a cancellation asks for a reason that is kept in the history.

The list can be filtered by state, assignee (Anyone, Me, Nobody or a person), job type, priority, Overdue only and due dates, and searched by reference, title or description. Save view keeps a set of filters under a name, and Share with colleagues makes it visible to everyone. Select several jobs to Reassign, Reschedule (by a number of days or to new dates) or Cancel jobs in one go; jobs that could not be changed are listed with the reason.

To plan when the work happens and who goes, use Schedule under Work: a job can have one or more visits, each with its own time and people. Timesheets, also under Work, shows each person’s shifts, travel and time on jobs week by week.`,
      keywords: [
        'work order',
        'job',
        'ticket',
        'visit',
        'create job',
        'assign',
        'dispatch',
        'crew',
        'schedule',
        'reschedule',
        'priority',
        'saved view',
        'bulk',
        'timesheets',
      ],
    },
    ar: {
      title: 'إنشاء أوامر العمل وإسنادها وتوجيهها',
      summary:
        'كيف ينشئ المكتب أمر عمل، ويختار الطاقم، ويوجّهه، ويصفّي القائمة ويحفظ طرق العرض، ويغيّر مهامًا كثيرة دفعة واحدة.',
      body: `افتح «أوامر العمل» تحت مجموعة العمل. يطلب «أمر عمل جديد» العميل والموقع ونوع المهمة وعنوانًا اختياريًا (يُستخدم اسم نوع المهمة إن تُرك فارغًا) والوصف والتعليمات (تعليمات نوع المهمة إن تُركت فارغة) ونافذة الاستحقاق (من وحتى) والطاقم. أحد أعضاء الطاقم هو القائد. يحفظ «إنشاء أمر العمل» المهمة بحالة «مجدولة».

يأتي كل نوع مهمة بنماذجه وقائمة التحقق والمدة المتوقعة والأولوية الافتراضية وشروط الإتمام، كما أعدّتها Integr8 معكم. والأولوية: منخفضة أو عادية أو عالية أو عاجلة.

في صفحة المهمة يمكنك تعديل التفاصيل، وتغيير الطاقم واختيار القائد، وإضافة نموذج أو إزالته، وإضافة بند إلى قائمة التحقق، وإرفاق ملف (مخطط الموقع أو دليل أو تقرير أو صورة أو غير ذلك)، وإضافة ملاحظات كل منها إما داخلية وإما يراها العميل. يسجّل السجل من أنشأ المهمة وعدّلها وأسندها وأعاد جدولتها ونقلها. وتُعرض المهام السابقة في هذا الموقع للاستئناس بها.

لإرسال المهمة إلى المهندس استخدم «نقل هذه المهمة إلى المرحلة التالية» واختر «توجيه». يراها المهندس حينئذ على الهاتف وينقلها عبر «في الطريق» و«في الموقع» و«قيد التنفيذ». التوجيه وإعادة الجدولة والإلغاء يقوم بها المنسّقون والمسؤولون والمالكون؛ ويطلب الإلغاء سببًا يُحفظ في السجل.

يمكن تصفية القائمة بالحالة والمسند إليه (أي شخص، أنا، لا أحد، أو شخص بعينه) ونوع المهمة والأولوية و«المتأخرة فقط» وتواريخ الاستحقاق، والبحث بالمرجع أو العنوان أو الوصف. يحفظ «حفظ طريقة العرض» مجموعة عوامل تصفية باسم، و«المشاركة مع الزملاء» تجعلها مرئية للجميع. حدّد عدة مهام لإعادة إسنادها أو إعادة جدولتها (بعدد أيام أو بتواريخ جديدة) أو إلغائها دفعة واحدة؛ وتُعرض المهام التي تعذّر تغييرها مع السبب.

ولتخطيط موعد العمل ومن يذهب إليه استخدم «الجدول» تحت العمل: يمكن أن تكون للمهمة زيارة واحدة أو أكثر، لكل منها وقتها وأشخاصها. وتعرض «سجلات الدوام»، تحت مجموعة العمل أيضًا، ورديات كل شخص وانتقاله ووقته على المهام أسبوعًا بأسبوع.`,
      keywords: [
        'أمر عمل',
        'اوامر العمل',
        'مهمة',
        'زيارة',
        'تذكرة',
        'إنشاء مهمة',
        'إسناد',
        'توجيه',
        'طاقم',
        'جدولة',
        'إعادة جدولة',
        'أولوية',
        'سجلات الدوام',
      ],
    },
  },
  {
    key: 'work_order_states_checklist_signoff',
    module: 'work_orders',
    feature: null,
    minPermission: null,
    appRoute: 'workOrders',
    public: {
      category: 'field-work',
      question: {
        en: 'What does a job need before it can be completed?',
        ar: 'ما الذي تحتاجه المهمة قبل إتمامها؟',
      },
    },
    en: {
      title: 'Work order states, completion and sign-off',
      summary:
        'The states a job moves through, what must be done before it can be completed, the customer’s sign-off, and how the office reviews or sends a job back.',
      body: `A work order moves through Scheduled, Dispatched, Travelling, On site, In progress and Complete, and finally Reviewed once the office signs it off. Awaiting parts can be used while work is paused, and Cancelled ends a job early with a reason. Every move is kept in the job’s History with who made it and when, and the time spent travelling, on site, working and waiting for parts is worked out from those moves and shown under Time on the job and on Timesheets.

Before a job can be completed, everything its job type requires must be done. The Still needed panel lists what is missing: each required form that has not been submitted, how many before and after photos are still to take, and the customer’s sign-off when the job type asks for one. Nothing is missing means the job can be completed; otherwise Complete job is refused, on the phone and in the office alike.

The customer’s sign-off is a signature drawn on the phone, with the name of the person signing and their role. When nobody is there to sign, the engineer records Nobody can sign with a reason, and the job says so. The signature can be viewed from the Completion section of the job.

The checklist is ticked item by item, and each tick shows who did it and when. Notes can be added by anybody on the job, marked Internal or Customer can see.

Once a job is Complete, an owner or admin reviews it: Sign off moves it to Reviewed, or Reopen sends it back with a reason so the crew can finish what was wrong. A cancelled job can be reinstated. Dispatchers move jobs on and reschedule them but do not sign them off.`,
      keywords: [
        'status',
        'state',
        'complete job',
        'sign off',
        'signature',
        'review',
        'reopen',
        'checklist',
        'awaiting parts',
        'cancel job',
        'photos required',
        'history',
      ],
    },
    ar: {
      title: 'حالات أمر العمل وإتمامه واعتماده',
      summary:
        'الحالات التي تمر بها المهمة، وما يجب إنجازه قبل إتمامها، واعتماد العميل بالتوقيع، وكيف يراجع المكتب المهمة أو يعيدها.',
      body: `يمر أمر العمل بالحالات: مجدولة، ثم موجَّهة، ثم في الطريق، ثم في الموقع، ثم قيد التنفيذ، ثم مكتملة، وأخيرًا معتمَدة بعد أن يعتمدها المكتب. وتُستخدم «بانتظار قطع الغيار» عند توقف العمل مؤقتًا، وتُنهي «ملغاة» المهمة مبكرًا بسبب. يُحفظ كل انتقال في سجل المهمة مع من أجراه ووقته، ويُحتسب الوقت المستغرق في الطريق وفي الموقع وفي العمل وفي انتظار القطع من تلك الانتقالات ويظهر تحت «الوقت على المهمة» وفي سجلات الدوام.

قبل إتمام المهمة يجب إنجاز كل ما يشترطه نوعها. تعرض لوحة «ما يزال مطلوبًا» ما ينقص: كل نموذج مطلوب لم يُرسل بعد، وعدد صور ما قبل العمل وما بعده المتبقية، واعتماد العميل إذا كان نوع المهمة يشترطه. «لا ينقص شيء» يعني أن المهمة يمكن إتمامها؛ وإلا فإن «إتمام المهمة» يُرفض على الهاتف وفي المكتب على السواء.

اعتماد العميل توقيع يُرسم على الهاتف، مع اسم الموقّع وصفته. وإذا لم يكن هناك من يوقّع، يسجّل المهندس «لا يستطيع أحد التوقيع» مع السبب، وتعرض المهمة ذلك. ويمكن عرض التوقيع من قسم «الإتمام» في المهمة.

تُعلَّم قائمة التحقق بندًا بندًا، ويظهر مع كل بند من أنجزه ومتى. ويمكن لأي شخص في المهمة إضافة ملاحظات، إما داخلية وإما يراها العميل.

بعد أن تصبح المهمة مكتملة يراجعها المالك أو المسؤول: «اعتماد» ينقلها إلى معتمَدة، أو «إعادة الفتح» يعيدها بسبب ليكمل الطاقم ما كان ناقصًا. ويمكن إعادة تفعيل مهمة ملغاة. ينقل المنسّقون المهام ويعيدون جدولتها لكنهم لا يعتمدونها.`,
      keywords: [
        'حالة المهمة',
        'الحالات',
        'إتمام المهمة',
        'اعتماد',
        'توقيع العميل',
        'مراجعة',
        'إعادة فتح',
        'قائمة التحقق',
        'بانتظار قطع الغيار',
        'إلغاء مهمة',
        'صور مطلوبة',
        'السجل',
      ],
    },
  },
  {
    key: 'mobile_engineer_workflow',
    module: 'mobile',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'phone-app',
      question: {
        en: 'What does an engineer do on the phone app?',
        ar: 'ماذا يفعل المهندس في تطبيق الهاتف؟',
      },
    },
    en: {
      title: 'The engineer’s day on the mobile app',
      summary:
        'Today’s jobs and the clock, working a job step by step, forms, photos, the customer’s sign-off, parts from the van and assets on site.',
      body: `The mobile app is for engineers. It opens on Today: Clock in starts your shift and Clock out ends it, the next job is shown with its address, due time and hazards, and the day’s jobs follow. Your jobs lists everything on the phone under Overdue, Today, Upcoming, No date yet and Closed in the last 30 days, and you can search by name, address or job number.

A job opens with the access notes and hazards first, then the one step forward as the main button: Start travel, Arrived, Start work, then Complete job. Waiting for parts and Stop travelling are there too. Directions and Open in maps take you to the site, and Call dials the site contact. Below are the instructions, the forms (Not started, Started, Submitted), the photos, the checklist, the files, the time on this job, and then the customer, site, due window, notes and earlier jobs at this site.

Photos: Take photo or choose From this phone, for the before and after sets the job type requires. The sign-off screen asks the customer to sign with a finger after checking the work, with their name and role; if nobody is there, choose Nobody can sign and say why.

Parts used: Use a part picks from your van as the office last had it, with the serial numbers or batches fitted. You need a van assigned to you; ask the office if you have none. Bought from a merchant records a part you paid for yourself, with its receipt photo, to claim back later as an expense. My van shows what you hold, and Refill my van asks the store for more.

Assets on this job lets you Scan a tag, link an asset at this site, Register an asset found on site and record its condition.

Complete job lists anything still missing and completes the job once nothing is. Everything you do is saved on the phone first and sent when there is signal.`,
      keywords: [
        'mobile app',
        'phone',
        'engineer',
        'today',
        'clock in',
        'clock out',
        'my jobs',
        'start travel',
        'arrived',
        'photos',
        'sign-off',
        'parts used',
        'my van',
        'scan tag',
      ],
    },
    ar: {
      title: 'يوم المهندس في تطبيق الهاتف',
      summary:
        'مهام اليوم وتسجيل الحضور، وتنفيذ المهمة خطوة بخطوة، والنماذج والصور واعتماد العميل، والقطع من السيارة والأصول في الموقع.',
      body: `تطبيق الهاتف مخصص للمهندسين. يُفتح على شاشة «اليوم»: «تسجيل الحضور» يبدأ ورديتك و«تسجيل الانصراف» ينهيها، وتُعرض المهمة التالية بعنوانها ووقت استحقاقها ومخاطرها، ثم تتبعها مهام اليوم. وتعرض شاشة «مهامك» كل ما على الهاتف تحت: متأخرة، واليوم، والقادمة، ولا يوجد تاريخ بعد، والمغلقة خلال آخر 30 يومًا، ويمكنك البحث بالاسم أو العنوان أو رقم المهمة.

تُفتح المهمة بملاحظات الدخول والمخاطر أولًا، ثم الخطوة التالية كزر رئيسي: «بدء الانتقال»، ثم «وصلت»، ثم «بدء العمل»، ثم «إتمام المهمة». وهناك أيضًا «بانتظار قطع الغيار» و«إيقاف الانتقال». يأخذك «الاتجاهات» و«فتح في الخرائط» إلى الموقع، ويتصل «اتصال» بجهة اتصال الموقع. وتحتها التعليمات، والنماذج (لم يبدأ، بدأ، أُرسل)، والصور، وقائمة التحقق، والملفات، والوقت على هذه المهمة، ثم العميل والموقع ونافذة الاستحقاق والملاحظات والمهام السابقة في هذا الموقع.

الصور: «التقاط صورة» أو الاختيار «من هذا الهاتف»، لمجموعتي ما قبل العمل وما بعده اللتين يشترطهما نوع المهمة. وتطلب شاشة اعتماد العميل أن يوقّع العميل بإصبعه بعد مراجعة العمل، مع اسمه وصفته؛ وإن لم يكن هناك أحد فاختر «لا يستطيع أحد التوقيع» واذكر السبب.

القطع المستخدمة: «استخدام قطعة» يختار من سيارتك كما كانت لدى المكتب آخر مرة، مع الأرقام التسلسلية أو الدفعات المركّبة. تحتاج إلى سيارة مخصصة لك؛ فاطلب من المكتب إن لم تكن لديك. و«شراء من تاجر» يسجّل قطعة دفعت ثمنها بنفسك مع صورة الإيصال، لتطالب بها لاحقًا كمصروف. وتعرض «سيارتي» ما تحمله، و«إعادة تعبئة سيارتي» تطلب المزيد من المخزن.

وتتيح «الأصول في هذه المهمة» مسح ملصق، أو ربط أصل في هذا الموقع، أو تسجيل أصل وُجد في الموقع وتسجيل حالته.

يعرض «إتمام المهمة» كل ما يزال ناقصًا ويُتم المهمة عندما لا ينقص شيء. وكل ما تفعله يُحفظ على الهاتف أولًا ويُرسل عند توفر الشبكة.`,
      keywords: [
        'تطبيق الهاتف',
        'الجوال',
        'الموبايل',
        'مهندس',
        'اليوم',
        'تسجيل الحضور',
        'تسجيل الانصراف',
        'مهامي',
        'بدء الانتقال',
        'وصلت',
        'الصور',
        'اعتماد العميل',
        'القطع المستخدمة',
        'سيارتي',
      ],
    },
  },
  {
    key: 'mobile_offline_sync',
    module: 'mobile',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'phone-app',
      question: {
        en: 'What happens when an engineer has no signal?',
        ar: 'ماذا يحدث عندما لا تتوفر إشارة لدى المهندس؟',
      },
    },
    en: {
      title: 'Working offline and the Sync screen',
      summary:
        'What the phone does without signal, how unsent work is kept and sent, what needs a connection, and how to settle a conflict.',
      body: `The mobile app works without signal. Your jobs, customers, sites, forms and files are downloaded to the phone, and every screen reads from the phone. Moving a job on, ticking the checklist, adding notes, correcting access notes, filling and submitting forms, photos, signatures, clocking in and out, parts used, parts bought from a merchant, registering assets and expense claims are all saved on the phone first and sent later, in the order you made them. The app can open without signal for up to seven days since you last signed in; after that, sign in again when you have a connection.

Some screens need a connection and keep nothing to send later: Refill my van, Receive goods, My payslips, the list of your recent expense claims, and the AI assistant. They say so when the phone is offline.

The banner at the top says where things stand: Sending your changes, Uploading files, Everything is sent, items waiting to send, No connection, Sign in again, or changes that need your attention. Each job also says Safe to leave or Not sent yet, so you know whether to stay in signal. Sync now forces a try. Large files wait for a charged battery unless you tap Sync now.

The Sync screen lists the changes and files waiting, with Try again for a failed upload. Under Needs your attention are changes the office could not take as they are: someone moved the job to another state while you were offline, someone else changed the same access note or the same form answer, the form was already submitted elsewhere, or the job could not be completed because something is still missing. Open the change to Decide: keep theirs, keep yours question by question, mark the job again, or Discard my change.

Signing out deletes every job, customer and file from the phone, including unsent work; the app warns you how many items would be lost. Closed jobs stay on the phone for 30 days; downloaded files are kept up to 500 MB; unsent work is never removed.`,
      keywords: [
        'offline',
        'no signal',
        'sync',
        'not sent yet',
        'outbox',
        'conflict',
        'needs attention',
        'upload',
        'safe to leave',
        'sync now',
        'sign out deletes',
        'connection',
      ],
    },
    ar: {
      title: 'العمل دون اتصال وشاشة المزامنة',
      summary:
        'ما يفعله الهاتف دون شبكة، وكيف يُحفظ العمل غير المرسل ويُرسل، وما يحتاج إلى اتصال، وكيف تحسم التعارض.',
      body: `يعمل تطبيق الهاتف دون شبكة. تُنزَّل مهامك وعملاؤك ومواقعك ونماذجك وملفاتك إلى الهاتف، وكل شاشة تقرأ من الهاتف، فلا مشكلة في غرفة معدات بلا تغطية. نقل المهمة، وتعليم قائمة التحقق، وإضافة الملاحظات، وتصحيح ملاحظات الدخول، وتعبئة النماذج وإرسالها، والصور، والتوقيعات، وتسجيل الحضور والانصراف، والقطع المستخدمة، والقطع المشتراة من تاجر، وتسجيل الأصول، ومطالبات المصروفات: كلها تُحفظ على الهاتف أولًا وتُرسل لاحقًا بالترتيب الذي أجريتها به. ويمكن فتح التطبيق دون شبكة حتى سبعة أيام منذ آخر تسجيل دخول؛ وبعدها سجّل الدخول مجددًا عند توفر الاتصال.

بعض الشاشات تحتاج إلى اتصال ولا تحفظ شيئًا لإرساله لاحقًا: «إعادة تعبئة سيارتي»، و«استلام البضائع»، و«قسائم راتبي»، وقائمة مطالباتك الأخيرة، والمساعد الذكي. وتخبرك بذلك عندما يكون الهاتف غير متصل.

يبيّن الشريط في الأعلى الوضع: جارٍ إرسال تغييراتك، أو جارٍ تحميل الملفات، أو أُرسل كل شيء، أو عناصر بانتظار الإرسال، أو لا يوجد اتصال، أو سجّل الدخول مجددًا، أو تغييرات تحتاج إلى انتباهك. وتقول كل مهمة أيضًا «يمكنك المغادرة بأمان» أو «لم يُرسل بعد»، لتعرف إن كان عليك البقاء في نطاق الشبكة قبل الانطلاق. و«المزامنة الآن» تجبر الهاتف على المحاولة. وتنتظر الملفات الكبيرة شحن البطارية ما لم تضغط «المزامنة الآن».

تعرض شاشة «المزامنة» التغييرات والملفات المنتظرة، مع «إعادة المحاولة» للتحميل الفاشل. وتحت «يحتاج إلى انتباهك» تغييرات لم يستطع المكتب قبولها كما هي: نقل أحدهم المهمة إلى حالة أخرى بينما كنت غير متصل، أو غيّر شخص آخر ملاحظة الدخول نفسها أو الإجابة نفسها في النموذج، أو أُرسل النموذج من مكان آخر، أو تعذّر إتمام المهمة لأن شيئًا ما يزال ناقصًا. افتح التغيير لتقرّر: الإبقاء على نسختهم، أو نسختك سؤالًا بسؤال، أو تعليم المهمة مجددًا، أو «تجاهل تغييري».

تسجيل الخروج يحذف كل مهمة وعميل وملف من الهاتف، بما في ذلك العمل غير المرسل؛ ويحذّرك التطبيق بعدد العناصر التي ستُفقد. تبقى المهام المغلقة على الهاتف 30 يومًا، وتُحفظ الملفات المنزّلة حتى 500 ميجابايت، ولا يُحذف العمل غير المرسل أبدًا.`,
      keywords: [
        'دون اتصال',
        'بدون انترنت',
        'لا توجد شبكة',
        'مزامنة',
        'لم يرسل بعد',
        'تعارض',
        'يحتاج إلى انتباهك',
        'تحميل',
        'المغادرة بأمان',
        'المزامنة الآن',
        'تسجيل الخروج يحذف',
        'اتصال',
      ],
    },
  },
  {
    key: 'forms_built_by_integr8',
    module: 'forms',
    feature: null,
    minPermission: 'form.read',
    appRoute: 'forms',
    public: {
      category: 'forms-documents',
      question: {
        en: 'Who builds our forms, and how do I get one changed?',
        ar: 'من يبني نماذجنا، وكيف أطلب تغيير نموذج؟',
      },
    },
    en: {
      title: 'Forms and job types: built by Integr8',
      summary:
        'What a form can contain, how versions work, how job types tie forms to jobs, and why changes go through Integr8.',
      body: `Integr8 builds each company’s forms and sets up its job types. Your people fill the forms and work the jobs; when a question needs rewording, a check needs changing or a new kind of job appears, you tell your Integr8 contact and they make the change. The Forms screen in the desktop app lists your forms with their status (Version N live, Not published yet, Unpublished changes), and owners and admins can look at them, but the builder is used by Integr8 staff.

A form has pages and sections. A section can repeat, so the same questions are asked once for each appliance or radiator found on site. Questions can be a short answer, a paragraph, a barcode or serial number scanned with the camera, whole or decimal numbers with units and limits, a rating, a date, a time, a dropdown, pick one, pick several, a tick box, yes or no, a signature, photos, files or a GPS location. A question can be shown only when other answers call for it, required only sometimes, worked out automatically from other answers, limited by checks with their own messages, or offered a narrower list depending on another answer. Some answers can be carried over from an asset’s last visit.

A published version never changes; the next change becomes a new version, and every submission stays with the version it was filled on. Each form’s settings say which roles may fill it, whether a signature is needed before a job using it can be closed, and which job types require it.

Job types, under Set-up, show the kinds of job you do: name, code, expected duration, default priority, instructions for the engineer, a checklist, the forms attached and whether each is required before completion, how many before and after photos are needed, and whether the customer signs off. Changes apply to jobs created from then on. The Get set up page tells you to send Integr8 the paperwork you use today, and they turn it into a form.`,
      keywords: [
        'form',
        'forms',
        'form builder',
        'questions',
        'checklist',
        'job type',
        'version',
        'published',
        'repeatable section',
        'signature required',
        'change a form',
        'integr8 builds forms',
      ],
    },
    ar: {
      title: 'النماذج وأنواع المهام: تبنيها Integr8',
      summary:
        'ما يمكن أن يحتويه النموذج، وكيف تعمل الإصدارات، وكيف تربط أنواع المهام النماذج بالمهام، ولماذا تمر التغييرات عبر Integr8.',
      body: `تبني Integr8 نماذج كل شركة وتُعدّ أنواع مهامها. يعبّئ موظفوك النماذج وينفّذون المهام؛ وعندما يحتاج سؤال إلى إعادة صياغة، أو يحتاج تحقق إلى تغيير، أو يظهر نوع مهمة جديد، تخبر جهة اتصالك في Integr8 فتجري التغيير. تعرض شاشة «النماذج» في تطبيق سطح المكتب نماذجك مع حالتها (الإصدار N مُفعَّل، لم يُنشر بعد، تغييرات غير منشورة)، ويمكن للمالكين والمسؤولين الاطلاع عليها، لكن منشئ النماذج يستخدمه موظفو Integr8.

يتكون النموذج من صفحات وأقسام. ويمكن أن يتكرر القسم، فتُطرح الأسئلة نفسها مرة لكل جهاز أو مشعاع في الموقع. وقد يكون السؤال إجابة قصيرة، أو فقرة، أو باركود أو رقمًا تسلسليًا يُمسح بالكاميرا، أو أرقامًا صحيحة أو عشرية بوحدات وحدود، أو تقييمًا، أو تاريخًا، أو وقتًا، أو قائمة منسدلة، أو اختيار واحد، أو اختيار عدة خيارات، أو مربع تحديد، أو نعم أو لا، أو توقيعًا، أو صورًا، أو ملفات، أو موقعًا جغرافيًا. ويمكن أن يظهر السؤال فقط عندما تستدعيه إجابات أخرى، أو يكون مطلوبًا أحيانًا فقط، أو يُحسب تلقائيًا من إجابات أخرى، أو يُقيَّد بتحققات لها رسائلها الخاصة، أو تُعرض له قائمة أضيق بحسب إجابة أخرى. ويمكن نقل بعض الإجابات من الزيارة السابقة للأصل.

الإصدار المنشور لا يتغير أبدًا؛ فالتغيير التالي يصبح إصدارًا جديدًا، ويبقى كل إرسال مع الإصدار الذي عُبّئ عليه. وتحدد إعدادات كل نموذج الأدوار التي يمكنها تعبئته، وما إذا كان التوقيع مطلوبًا قبل إغلاق مهمة تستخدمه، وأنواع المهام التي تشترطه.

تعرض «أنواع المهام»، تحت مجموعة الإعداد، أنواع الأعمال التي تنفّذها: الاسم والرمز والمدة المتوقعة والأولوية الافتراضية وتعليمات المهندس وقائمة التحقق والنماذج المرفقة وهل كل منها مطلوب قبل الإتمام، وعدد صور ما قبل العمل وما بعده، وهل يعتمد العميل المهمة بتوقيعه. تسري التغييرات على المهام التي تُنشأ من ذلك الحين. وتطلب منك صفحة «ابدأ الإعداد» إرسال الأوراق التي تستخدمها اليوم إلى Integr8 لتحوّلها إلى نموذج.`,
      keywords: [
        'نموذج',
        'نماذج',
        'منشئ النماذج',
        'أسئلة',
        'قائمة التحقق',
        'نوع المهمة',
        'انواع المهام',
        'إصدار',
        'منشور',
        'قسم متكرر',
        'توقيع مطلوب',
        'تعديل نموذج',
      ],
    },
  },
  {
    key: 'submissions_fill_and_correct',
    module: 'forms',
    feature: null,
    minPermission: null,
    appRoute: 'submissions',
    public: {
      category: 'forms-documents',
      question: {
        en: 'How are forms filled in, and can a submitted form be corrected?',
        ar: 'كيف تُعبّأ النماذج، وهل يمكن تصحيح نموذج مُرسل؟',
      },
    },
    en: {
      title: 'Filling in forms and correcting submissions',
      summary:
        'Starting a form from a job or from Fill in a form, submitting it, finding submissions, exporting them and reopening one to correct it.',
      body: `A form is usually filled from its job: open the job, find it under Forms and choose Fill in, Continue or View. Forms can also be started from Fill in a form under Work, which lists the forms you may fill and, under Carry on where you left off, your unfinished drafts. Answers are saved as you go. On the phone the form works without signal and is sent with the next sync; if the same form was filled at this site before, the phone offers to start from those earlier answers, which you then check.

Signatures are drawn with a finger, mouse or trackpad, or typed as a name. Photos and files are added from the camera or the device. A GPS question records where you are. Review answers shows everything before Submit, and problems are listed with a link to each question. Once submitted, a form reaches the office with the next sync.

Submissions under Work lists everything filled in, with filters for the form, status (Draft, Submitted, Reopened for correction), who submitted it, dates, customer, site and job, plus Filter by an answer to find, for example, every form where a reading is above a value. Only mine narrows the list to your own. Choose a form, then Export CSV to download its answers. Each submission shows the version it was filled on, its history and, when captured, the location it was submitted from.

A submitted form can be corrected. An owner or admin opens it and chooses Reopen to correct, saying why. The person correcting it changes the answers and chooses Submit correction, again saying why. The original answers stay in the history, and every reopening and correction is kept with its reason and name. Corrections never count against the monthly submission allowance.

Engineers see their own submissions; dispatchers, viewers, admins and owners see everybody’s. Dispatchers can fill a form on an engineer’s behalf, but reopening is left to owners and admins.`,
      keywords: [
        'fill in form',
        'submit form',
        'submission',
        'draft',
        'correction',
        'reopen',
        'amend',
        'export csv',
        'filter answers',
        'signature',
        'photos',
        'only mine',
      ],
    },
    ar: {
      title: 'تعبئة النماذج وتصحيح الإرسالات',
      summary:
        'بدء نموذج من مهمة أو من «تعبئة نموذج»، وإرساله، والعثور على الإرسالات وتصديرها، وإعادة فتح إرسال لتصحيحه.',
      body: `يُعبَّأ النموذج عادةً من مهمته: افتح المهمة، وابحث عنه تحت «النماذج»، واختر «تعبئة» أو «متابعة» أو «عرض». ويمكن أيضًا بدء النماذج من «تعبئة نموذج» تحت مجموعة العمل، حيث تُعرض النماذج التي يمكنك تعبئتها، وتحت «تابع من حيث توقفت» مسوداتك غير المكتملة. تُحفظ الإجابات أثناء الكتابة. وعلى الهاتف يعمل النموذج دون شبكة ويُرسل مع المزامنة التالية؛ وإذا عُبّئ النموذج نفسه في هذا الموقع من قبل، يعرض الهاتف البدء من تلك الإجابات السابقة لتراجعها.

تُرسم التوقيعات بالإصبع أو الفأرة أو لوحة اللمس، أو تُكتب كاسم. وتُضاف الصور والملفات من الكاميرا أو الجهاز. ويسجّل سؤال الموقع الجغرافي مكانك. يعرض «مراجعة الإجابات» كل شيء قبل «إرسال»، وتُعرض المشكلات مع رابط إلى كل سؤال. وبعد الإرسال يصل النموذج إلى المكتب مع المزامنة التالية.

تعرض «الإرسالات» تحت مجموعة العمل كل ما عُبّئ، مع عوامل تصفية بالنموذج والحالة (مسودة، أُرسل، أُعيد فتحه للتصحيح) ومن أرسله والتواريخ والعميل والموقع والمهمة، إضافة إلى «التصفية بإجابة» للعثور مثلًا على كل نموذج تجاوزت فيه قراءة قيمة معينة. و«إرسالاتي فقط» تقصر القائمة على إرسالاتك. اختر نموذجًا ثم «تصدير CSV» لتنزيل إجاباته. ويعرض كل إرسال الإصدار الذي عُبّئ عليه وسجله، والموقع الذي أُرسل منه إن سُجّل.

يمكن تصحيح نموذج مُرسَل. يفتحه المالك أو المسؤول ويختار «إعادة الفتح للتصحيح» مع ذكر السبب. ثم يغيّر من يصحّحه الإجابات ويختار «إرسال التصحيح» مع ذكر السبب أيضًا. تبقى الإجابات الأصلية في السجل، ويُحفظ كل إعادة فتح وكل تصحيح مع سببه واسم صاحبه. ولا تُحتسب التصحيحات أبدًا ضمن حصة الإرسالات الشهرية.

يرى المهندسون إرسالاتهم فقط؛ ويرى المنسّقون والمشاهدون والمسؤولون والمالكون إرسالات الجميع. ويستطيع المنسّق تعبئة نموذج نيابةً عن مهندس، أما إعادة الفتح فللمالكين والمسؤولين.`,
      keywords: [
        'تعبئة نموذج',
        'تعبئة النماذج',
        'إرسال نموذج',
        'إرسالات',
        'مسودة',
        'تصحيح',
        'إعادة فتح',
        'تعديل إرسال',
        'تصدير',
        'تصفية الإجابات',
        'توقيع',
        'صور',
      ],
    },
  },
  {
    key: 'crm_leads_conversion',
    module: 'crm',
    feature: 'crm',
    minPermission: 'crm.read',
    appRoute: 'leads',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do leads become customers?',
        ar: 'كيف يتحول العملاء المحتملون إلى عملاء؟',
      },
    },
    en: {
      title: 'CRM leads and converting them into customers',
      summary:
        'Adding and qualifying leads, assigning them, and the three-step conversion into an existing or new customer.',
      body: `The CRM group appears when Integr8 has switched the CRM module on for your company. CRM overview shows the open pipeline, the weighted forecast, what was won in the last 30 days and the follow-ups due. Leads are prospects before they become customers.

New lead asks for a name, company, email, phone, source (Added by hand, Referral, Website, Import, Other), status, who it is assigned to, an estimated value with its currency, and notes. The estimated value is an estimate, not booked revenue. Statuses are New, Contacted, Qualified, Not a fit (with a reason) and Converted. Leads can be archived and restored, filtered by status, source and assignee, searched by name, company, email or phone, and downloaded as CSV. Calls, meetings and follow-ups are logged on the lead under Activity.

Convert to customer takes three steps. First, choose which customer this is: the CRM suggests existing customers that share an email, phone number or name with the lead, you can search for another, or add a new customer filled in from the lead. Second, choose the customer’s contact: nobody for now, keep the existing one, or add the lead as a new contact. Third, check the summary and convert; you can also open an opportunity for the customer at the same time. A lead converts once and keeps its history; its page then says it became a customer and links to it. Only an open lead can be converted: restore an archived one, or move it back to an open status, first.

Dispatchers, admins and owners add, qualify and convert leads; viewers read the CRM without changing it. Engineers do not see the CRM.`,
      keywords: [
        'crm',
        'lead',
        'prospect',
        'qualify',
        'convert lead',
        'new customer from lead',
        'source',
        'assigned',
        'not a fit',
        'estimated value',
        'crm overview',
      ],
    },
    ar: {
      title: 'العملاء المحتملون وتحويلهم إلى عملاء',
      summary:
        'إضافة العملاء المحتملين وتأهيلهم وإسنادهم، والتحويل بثلاث خطوات إلى عميل موجود أو جديد.',
      body: `تظهر مجموعة «إدارة علاقات العملاء» عندما تفعّل Integr8 هذه الوحدة لشركتك. تعرض «نظرة عامة على إدارة علاقات العملاء» مسار المبيعات المفتوح، والتوقع المرجّح، وما كُسب خلال آخر 30 يومًا، والمتابعات المستحقة. و«العملاء المحتملون» هم الجهات المحتملة قبل أن تصبح عملاء.

يطلب «عميل محتمل جديد» الاسم والشركة والبريد الإلكتروني والهاتف والمصدر (أُضيف يدويًا، إحالة، الموقع الإلكتروني، استيراد، أخرى) والحالة والمسند إليه والقيمة التقديرية بعملتها والملاحظات. والقيمة التقديرية تقدير لا إيراد مؤكد. الحالات: جديد، وتم التواصل، ومؤهَّل، وغير ملائم (مع السبب)، وتم التحويل. يمكن أرشفة العملاء المحتملين واستعادتهم، وتصفيتهم بالحالة والمصدر والمسند إليه، والبحث فيهم بالاسم أو الشركة أو البريد الإلكتروني أو الهاتف، وتنزيلهم بصيغة CSV. وتُسجَّل المكالمات والاجتماعات والمتابعات على العميل المحتمل تحت «النشاط».

يتم «التحويل إلى عميل» بثلاث خطوات. أولًا، اختر أي عميل هذا: يقترح النظام عملاء موجودين يشتركون مع العميل المحتمل في البريد الإلكتروني أو رقم الهاتف أو الاسم، ويمكنك البحث عن عميل آخر أو إضافة عميل جديد معبّأ من بيانات العميل المحتمل. ثانيًا، اختر جهة اتصال العميل: لا أحد الآن، أو الإبقاء على الموجودة، أو إضافة العميل المحتمل كجهة اتصال جديدة. ثالثًا، راجع الملخص وحوّل؛ ويمكنك أيضًا فتح فرصة لهذا العميل في الوقت نفسه. يُحوَّل العميل المحتمل مرة واحدة ويحتفظ بسجله؛ وتقول صفحته بعدها إنه أصبح عميلًا وتربط إليه. ولا يُحوَّل إلا عميل محتمل مفتوح: استعد المؤرشف أو أعده إلى حالة مفتوحة أولًا.

يضيف المنسّقون والمسؤولون والمالكون العملاء المحتملين ويؤهلونهم ويحوّلونهم؛ ويقرأ المشاهدون إدارة علاقات العملاء دون تغيير. ولا يرى المهندسون هذه الوحدة.`,
      keywords: [
        'عميل محتمل',
        'عملاء محتملين',
        'إدارة علاقات العملاء',
        'crm',
        'تأهيل',
        'تحويل عميل محتمل',
        'عميل جديد',
        'مصدر',
        'مسند إلى',
        'غير ملائم',
        'قيمة تقديرية',
      ],
    },
  },
  {
    key: 'crm_opportunities_pipeline_followups',
    module: 'crm',
    feature: 'crm',
    minPermission: 'crm.read',
    appRoute: 'opportunities',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do I follow deals through the pipeline?',
        ar: 'كيف أتابع الصفقات عبر مسار المبيعات؟',
      },
    },
    en: {
      title: 'Opportunities, the pipeline board and follow-ups',
      summary:
        'Working deals on the board or in the list, winning and losing them, keeping pipelines and stages, and logging calls, meetings and tasks.',
      body: `Opportunities are the deals you are working on, each for a customer or a lead, with a title, an estimated amount, a chance of winning, an expected close date, an owner and a description. Amounts are estimates, not booked revenue; winning an opportunity creates no invoice and no job. New opportunity adds one, and the list and board can be filtered, searched and downloaded as CSV.

Show as Board lays opportunities out by stage, and a card is dragged from one stage to the next; the move is recorded in the opportunity’s History and can be undone from the message that appears. Dropping a card on Close a deal asks whether it was won or lost; Mark lost asks why. Show as List gives the same opportunities as rows. The standard stages are New, Qualified, Proposal, Negotiation, Won and Lost.

Pipelines, visible to owners and admins, is where the stages are kept: add a pipeline, rename it, make it the default, add a stage at the end and move it where it belongs, give each stage its usual chance of winning, and archive a stage or a pipeline. An archived stage keeps its history; its open opportunities are moved to a stage you choose. Everyone else uses the stages as they are.

Follow-ups lists the calls, meetings and tasks that are due, under Overdue, Today, Upcoming, No date and Done, with Only mine to narrow it. Add activity logs a Call, Email, Meeting, Note, Follow-up or Task on a lead, an opportunity or a customer, with a subject, a due date and who it is assigned to; tick Already done to log something that happened rather than set a reminder, and Mark done when it is finished.

CRM reports shows quote conversion, win rate and pipeline value by month. Dispatchers and above manage opportunities and activities; viewers read them.`,
      keywords: [
        'opportunity',
        'deal',
        'pipeline',
        'board',
        'kanban',
        'stage',
        'won',
        'lost',
        'follow-up',
        'activity',
        'call',
        'meeting',
        'task',
        'crm reports',
      ],
    },
    ar: {
      title: 'الفرص ولوحة مسار المبيعات والمتابعات',
      summary:
        'العمل على الصفقات في اللوحة أو القائمة، وكسبها أو خسارتها، وإدارة مسارات المبيعات ومراحلها، وتسجيل المكالمات والاجتماعات والمهام.',
      body: `الفرص هي الصفقات التي تعمل عليها، كل منها لعميل أو عميل محتمل، ولها عنوان ومبلغ تقديري واحتمال كسب وتاريخ إغلاق متوقع ومالك ووصف. المبالغ تقديرية لا إيرادًا مؤكدًا؛ وكسب الفرصة لا ينشئ فاتورة ولا مهمة. يضيف «فرصة جديدة» فرصة، ويمكن تصفية القائمة واللوحة والبحث فيهما وتنزيلهما بصيغة CSV.

يرتّب «العرض كلوحة» الفرص بحسب المرحلة، وتُسحب البطاقة من مرحلة إلى التي تليها؛ ويُسجَّل النقل في سجل الفرصة ويمكن التراجع عنه من الرسالة التي تظهر. وإسقاط بطاقة على «إغلاق صفقة» يسأل هل كُسبت أم خُسرت؛ ويطلب «تعليمها خاسرة» السبب. ويعرض «العرض كقائمة» الفرص نفسها كصفوف. والمراحل القياسية: جديدة، ومؤهلة، وعرض مقدَّم، وتفاوض، ومكسوبة، وخاسرة.

«مسارات المبيعات»، وتظهر للمالكين والمسؤولين، هي حيث تُدار المراحل: أضف مسارًا، أو أعد تسميته، أو اجعله الافتراضي، أو أضف مرحلة في النهاية وانقلها إلى مكانها، وأعطِ كل مرحلة احتمال الكسب المعتاد، وأرشف مرحلة أو مسارًا. تحتفظ المرحلة المؤرشفة بسجلها، وتُنقل فرصها المفتوحة إلى مرحلة تختارها. ويستخدم الآخرون المراحل كما هي.

تعرض «المتابعات» المكالمات والاجتماعات والمهام المستحقة تحت: متأخرة، واليوم، والقادمة، وبلا تاريخ، ومنجزة، مع «متابعاتي فقط» لتضييقها. ويسجّل «إضافة نشاط» مكالمة أو بريدًا إلكترونيًا أو اجتماعًا أو ملاحظة أو متابعة أو مهمة على عميل محتمل أو فرصة أو عميل، مع الموضوع وتاريخ الاستحقاق والمسند إليه؛ علّم «أُنجز بالفعل» لتسجيل شيء حدث بدل ضبط تذكير، و«تعليمه منجزًا» عند الانتهاء.

وتعرض «تقارير إدارة علاقات العملاء» تحويل عروض الأسعار ونسبة الكسب وقيمة مسار المبيعات حسب الشهر. يدير المنسّقون ومن فوقهم الفرص والأنشطة؛ ويقرأها المشاهدون.`,
      keywords: [
        'فرصة',
        'فرص',
        'صفقة',
        'مسار المبيعات',
        'لوحة',
        'مرحلة',
        'مكسوبة',
        'خاسرة',
        'متابعة',
        'متابعات',
        'نشاط',
        'مكالمة',
        'اجتماع',
        'تقارير',
      ],
    },
  },
  {
    key: 'sales_quotes_orders_deliveries',
    module: 'sales',
    feature: 'sales',
    minPermission: 'sales.read',
    appRoute: 'quotes',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do quotes, sales orders and deliveries work?',
        ar: 'كيف تعمل عروض الأسعار وأوامر البيع والتسليمات؟',
      },
    },
    en: {
      title: 'Quotes, sales orders and deliveries',
      summary:
        'Drafting and issuing a quote, the link the customer answers through, converting it to an order, reserving stock, delivering and linking jobs.',
      body: `The Sales group appears when Integr8 has switched the sales module on. New quote under Quotes asks for the customer and optionally the site, contact and opportunity, a title, a valid-until date and the lines: a catalogue item fills in the description, unit and sale price, or type a description; each line has a quantity, unit price, discount and tax. An introduction and terms are printed; internal notes never are. Print or save as PDF gives the document, watermarked Draft until it is issued.

A draft is only visible to your team. Issue, done by an owner or admin, fixes the lines and creates the customer link: copy it and send it to the customer, who can read the quote and Accept or Decline without signing in, giving their name. The link is shown once. If the customer answers by phone or email instead, use Record answer. A quote can be revised (the old revision closes and its link stops working), withdrawn, and expires after its valid-until date. Statuses are Draft, Issued, Accepted, Rejected, Converted and Withdrawn.

Convert to order makes a sales order from an accepted quote; New sales order drafts one from scratch. Confirm, again by an owner or admin, fixes the lines and, when the inventory module is on, reserves each stock line at the location you choose; what is not there is flagged To order and appears on the Inventory overview. Re-run reservation holds the stock again after goods arrive.

Deliver hands over some or all of what is left from one of your locations and prints a delivery note without prices. Link or create job ties jobs to the order: parts used on a linked job come out of the order’s reservation and count as delivered, and service lines are delivered when the job completes. Cancelling an order releases everything it holds. With the finance module on, Invoice this order drafts the invoice.

Dispatchers draft quotes and orders and record answers; issuing and confirming are for owners and admins.`,
      keywords: [
        'quote',
        'quotation',
        'estimate',
        'sales order',
        'customer link',
        'accept quote',
        'issue quote',
        'confirm order',
        'reserve stock',
        'delivery',
        'delivery note',
        'link job',
      ],
    },
    ar: {
      title: 'عروض الأسعار وأوامر البيع والتسليمات',
      summary:
        'إعداد عرض سعر وإصداره، والرابط الذي يرد العميل من خلاله، وتحويله إلى أمر بيع، وحجز المخزون، والتسليم وربط المهام.',
      body: `تظهر مجموعة «المبيعات» عندما تفعّل Integr8 وحدة المبيعات. يطلب «عرض سعر جديد» تحت «عروض الأسعار» العميل، واختياريًا الموقع وجهة الاتصال والفرصة، والعنوان وتاريخ الصلاحية والبنود: يعبّئ صنف الكتالوج الوصف والوحدة وسعر البيع، أو اكتب وصفًا؛ ولكل بند كمية وسعر وحدة وخصم وضريبة. تُطبع المقدمة والشروط؛ أما الملاحظات الداخلية فلا تُطبع أبدًا. ويعطي «طباعة أو حفظ بصيغة PDF» المستند بعلامة «مسودة» حتى يُصدر.

المسودة لا يراها إلا فريقك. و«إصدار»، الذي يقوم به المالك أو المسؤول، يثبّت البنود وينشئ رابط العميل: انسخه وأرسله إلى العميل، فيقرأ عرض السعر ويقبله أو يرفضه دون تسجيل دخول، مع ذكر اسمه. ويُعرض الرابط مرة واحدة فقط. وإذا رد العميل بالهاتف أو البريد الإلكتروني فاستخدم «تسجيل الرد». ويمكن تنقيح عرض السعر (تُغلق النسخة القديمة ويتوقف رابطها) أو سحبه، وتنتهي صلاحيته بعد تاريخ الصلاحية. الحالات: مسودة، وصادر، ومقبول، ومرفوض، ومحوَّل، ومسحوب.

يُنشئ «التحويل إلى أمر بيع» أمر بيع من عرض سعر مقبول؛ و«أمر بيع جديد» يُعدّ أمرًا من البداية. و«تأكيد»، وهو أيضًا للمالك أو المسؤول، يثبّت البنود، وعند تفعيل وحدة المخزون يحجز كل بند مخزني في الموقع الذي تختاره؛ وما ليس متوفرًا يُعلَّم «للطلب» ويظهر في نظرة عامة على المخزون. و«إعادة تشغيل الحجز» يحجز المخزون مجددًا بعد وصول البضائع.

يسلّم «تسليم» بعض ما تبقى أو كله من أحد مواقعك ويطبع إشعار تسليم بلا أسعار. ويربط «ربط مهمة أو إنشاؤها» المهام بالأمر: القطع المستخدمة في مهمة مرتبطة تُخصم من حجز الأمر وتُحتسب مسلَّمة، وتُسلَّم بنود الخدمات عند إتمام المهمة. وإلغاء الأمر يحرّر كل ما يحجزه. ومع تفعيل وحدة المالية، يُعدّ «فوترة هذا الأمر» مسودة الفاتورة.

يُعدّ المنسّقون مسودات عروض الأسعار والأوامر ويسجّلون الردود؛ أما الإصدار والتأكيد فللمالكين والمسؤولين.`,
      keywords: [
        'عرض سعر',
        'عروض الأسعار',
        'عرض اسعار',
        'أمر بيع',
        'اوامر البيع',
        'رابط العميل',
        'قبول عرض السعر',
        'إصدار',
        'تأكيد الطلب',
        'حجز المخزون',
        'تسليم',
        'إشعار تسليم',
      ],
    },
  },
  {
    key: 'inventory_items_locations_vans',
    module: 'inventory',
    feature: 'inventory',
    minPermission: 'inventory.read',
    appRoute: 'inventory',
    public: {
      category: 'stock-assets',
      question: {
        en: 'How do I keep items, stock locations and vans?',
        ar: 'كيف أدير الأصناف ومواقع المخزون والسيارات؟',
      },
    },
    en: {
      title: 'Inventory: items, stock locations and vans',
      summary:
        'The catalogue of items, warehouses, vans and customer sites, reorder levels, van requests from engineers and the Inventory overview.',
      body: `The Inventory group appears when Integr8 has switched the inventory module on. The Inventory overview shows what is below its reorder level, what must be ordered for confirmed sales orders, the latest movements and Check the ledger, which replays every movement and confirms each balance agrees with it. Every quantity in the product comes from that ledger of movements.

Items is the catalogue: what you stock, buy, use and sell. Each item has a SKU, name, kind (Stock item, Non-stock item or Service), unit, category, barcode, default and average unit cost, sale price, description and lead time in days. An item can have a preferred supplier, which reorders and planning go to, images and PDF datasheets, and Reorder levels per location, below which it shows as running low. Track by serial number or batch switches an item to being told apart unit by unit or by batch code with an expiry date. Items are archived rather than deleted.

Stock locations are of three kinds: Warehouse, Van and Customer site. A van is assigned to one person under Who drives this van, and an engineer records parts used from the van assigned to them. A customer site can hold Our stock, moved there by transfer and used on jobs, or The customer’s stock, a record of what the customer holds that is never valued. Each location shows what it holds and lets you Start a count.

Van requests is the store’s queue: engineers ask for a refill from the phone (Refill my van), and somebody at the store picks the request from a warehouse and sends the goods to the van, fewer than asked if that is all there is. Parts used reports what was used on jobs by engineer, customer or job type, and Serial lookup finds a serial number or batch and where it has been.

Everybody with inventory access sees stock; costs are shown to those who move stock. Dispatchers, inventory managers, admins and owners add items and locations.`,
      keywords: [
        'inventory',
        'stock',
        'item',
        'sku',
        'catalogue',
        'warehouse',
        'van',
        'stock location',
        'reorder level',
        'low stock',
        'van request',
        'refill van',
        'datasheet',
      ],
    },
    ar: {
      title: 'المخزون: الأصناف ومواقع المخزون والسيارات',
      summary:
        'كتالوج الأصناف، والمستودعات والسيارات ومواقع العملاء، وحدود إعادة الطلب، وطلبات السيارات من المهندسين، ونظرة عامة على المخزون.',
      body: `تظهر مجموعة «المخزون» عندما تفعّل Integr8 وحدة المخزون. تعرض نظرة عامة على المخزون ما هو أقل من حد إعادة الطلب، وما يجب طلبه لأوامر البيع المؤكدة، وآخر الحركات، و«التحقق من السجل» الذي يعيد تشغيل كل حركة ويؤكد أن كل رصيد يطابقه. وكل كمية في المنتج مستمدة من سجل الحركات ذاك.

«الأصناف» هي الكتالوج: ما تخزنه وتشتريه وتستخدمه وتبيعه. لكل صنف رمز (SKU) واسم ونوع (صنف مخزني أو صنف غير مخزني أو خدمة) ووحدة وفئة وباركود وتكلفة وحدة افتراضية ومتوسطة وسعر بيع ووصف ومدة توريد بالأيام. ويمكن أن يكون للصنف مورّد مفضّل تذهب إليه إعادة الطلب والتخطيط، وصور وأوراق بيانات PDF، و«حدود إعادة الطلب» لكل موقع يظهر الصنف دونها على أنه ينخفض. و«التتبع بالرقم التسلسلي أو الدفعة» يحوّل الصنف إلى التمييز بين وحداته واحدة واحدة أو برمز دفعة له تاريخ انتهاء. وتُؤرشف الأصناف ولا تُحذف.

«مواقع المخزون» ثلاثة أنواع: مستودع، وسيارة، وموقع عميل. تُخصَّص السيارة لشخص واحد تحت «من يقود هذه السيارة»، ويسجّل المهندس القطع المستخدمة من السيارة المخصصة له. ويمكن أن يحمل موقع العميل «مخزوننا»، المنقول إليه بتحويل والمستخدم في المهام هناك، أو «مخزون العميل»، وهو سجل لما يحتفظ به العميل ولا يُقوَّم أبدًا. ويعرض كل موقع ما يحمله ويتيح «بدء جرد».

«طلبات السيارات» هي طابور المخزن: يطلب المهندسون إعادة التعبئة من الهاتف («إعادة تعبئة سيارتي»)، ويجهّز أحد العاملين في المخزن الطلب من مستودع ويرسل البضائع إلى السيارة، وقد تكون أقل مما طُلب إن كان ذلك كل المتوفر. وتعرض «القطع المستخدمة» ما استُخدم في المهام حسب المهندس أو العميل أو نوع المهمة، و«البحث بالرقم التسلسلي» يعثر على رقم تسلسلي أو دفعة وأين كانت.

كل من له صلاحية المخزون يرى الكميات؛ وتُعرض التكاليف لمن يحرّكون المخزون. ويضيف المنسّقون ومديرو المخزون والمسؤولون والمالكون الأصناف والمواقع.`,
      keywords: [
        'مخزون',
        'المخزن',
        'صنف',
        'أصناف',
        'اصناف',
        'كتالوج',
        'مستودع',
        'سيارة',
        'موقع مخزون',
        'حد إعادة الطلب',
        'نقص المخزون',
        'طلب سيارة',
        'تعبئة السيارة',
      ],
    },
  },
  {
    key: 'inventory_movements_counts_serials',
    module: 'inventory',
    feature: 'inventory',
    minPermission: 'inventory.read',
    appRoute: 'stockLocations',
    public: {
      category: 'stock-assets',
      question: {
        en: 'How is stock moved, counted and tracked by serial number?',
        ar: 'كيف يُنقل المخزون ويُجرد ويُتتبع بالأرقام التسلسلية؟',
      },
    },
    en: {
      title: 'Stock movements, counts, parts on jobs and serial numbers',
      summary:
        'Receiving, issuing, transferring and correcting stock, posting a count, recording and returning parts used on jobs, and following serial numbers and batches.',
      body: `Stock changes only through movements, each kept with who made it and when. Move stock records Received stock, Issued stock, Transferred between locations or Corrected a quantity; an issue or a correction needs a reason, and a received unit cost folds into the item’s average cost. The movement kinds you will see on an item are Received, Issued, Transferred out and in, Adjusted, Counted, Used on a job, Returned from a job, Returned to supplier, and used in or made by an assembly.

A stock count starts from a location with Start a count. Enter what was counted for each item, add more items as you go, Save count and then Post count: posting adjusts stock to what was counted and leaves items not on the count alone.

Parts used on a job are recorded by the engineer from the van assigned to them, or by the office from any location, with a quantity and a note. The job shows its parts cost. If the location did not hold enough when the part was recorded, the use is flagged Needs attention and nothing is taken from stock; the office puts the stock right and chooses Retry, changes the quantity or location, or cancels the use. Return puts a part back where it came from, never more than was used.

Items tracked by serial number or batch ask which units moved. On a receipt you type, paste or scan the serial numbers, or give batch codes with an expiry date and quantity, and the screen says whether it adds up. On an issue, transfer or part used you choose which serial numbers or batches; the earliest expiry is proposed, and an expired batch can be used only with a reason. Serial lookup finds a code by its first characters and opens a trace: where it is now and every place it has been, with the job it was used on and the asset it was fitted to.

Moving and counting stock is for dispatchers, inventory managers, admins and owners; engineers record parts on their own jobs.`,
      keywords: [
        'stock movement',
        'receive stock',
        'issue stock',
        'transfer',
        'adjustment',
        'stock count',
        'stocktake',
        'parts used',
        'return part',
        'serial number',
        'batch',
        'expiry',
        'serial lookup',
        'trace',
      ],
    },
    ar: {
      title: 'حركات المخزون والجرد والقطع في المهام والأرقام التسلسلية',
      summary:
        'استلام المخزون وصرفه وتحويله وتسويته، وترحيل الجرد، وتسجيل القطع المستخدمة في المهام وإرجاعها، وتتبع الأرقام التسلسلية والدفعات.',
      body: `لا يتغير المخزون إلا عبر الحركات، وتُحفظ كل حركة مع من أجراها ووقتها. يسجّل «نقل المخزون» استلام مخزون أو صرف مخزون أو تحويلًا بين موقعين أو تصحيح كمية؛ ويحتاج الصرف أو التصحيح إلى سبب، وتُدمج تكلفة الوحدة المستلمة في متوسط تكلفة الصنف. وأنواع الحركات التي تراها على الصنف: استلام، وصرف، وتحويل صادر ووارد، وتسوية، وجرد، واستُخدم في مهمة، ومرتجع من مهمة، ومرتجع إلى المورّد، واستُخدم في تجميع أو ناتج تجميع.

يبدأ الجرد من موقع عبر «بدء جرد». أدخل ما عُدّ لكل صنف، وأضف أصنافًا أخرى أثناء العمل، ثم «حفظ الجرد» ثم «ترحيل الجرد»: يعدّل الترحيل المخزون إلى ما عُدّ ويترك الأصناف غير المدرجة في الجرد كما هي. ويمكن إلغاء الجرد قبل ترحيله.

يسجّل المهندس القطع المستخدمة في المهمة من السيارة المخصصة له، أو يسجّلها المكتب من أي موقع، مع الكمية وملاحظة. وتعرض المهمة تكلفة قطعها. وإذا لم يكن الموقع يحمل ما يكفي عند تسجيل القطعة، يُعلَّم الاستخدام «يحتاج إلى انتباه» ولا يُخصم شيء من المخزون؛ فيصحح المكتب المخزون ويختار «إعادة المحاولة»، أو يغيّر الكمية أو الموقع، أو يلغي الاستخدام. و«إرجاع» يعيد القطعة إلى حيث جاءت، ولا يزيد أبدًا عمّا استُخدم. وتُعرض القطع التي تحتاج إلى انتباه في نظرة عامة على المخزون.

تسأل الأصناف المتتبَّعة بالرقم التسلسلي أو الدفعة عن الوحدات التي تحركت. عند الاستلام تكتب الأرقام التسلسلية أو تلصقها أو تمسحها، أو تعطي رموز الدفعات مع تاريخ الانتهاء والكمية، وتخبرك الشاشة إن كان المجموع صحيحًا. وعند الصرف أو التحويل أو استخدام قطعة تختار الأرقام التسلسلية أو الدفعات؛ وتُقترح الدفعة الأقرب انتهاءً، ولا تُستخدم دفعة منتهية إلا بسبب. ويعثر «البحث بالرقم التسلسلي» على رمز بأحرفه الأولى ويفتح تتبعًا: أين هو الآن وكل مكان كان فيه، مع المهمة التي استُخدم فيها والأصل الذي رُكّب فيه.

تحريك المخزون وجرده للمنسّقين ومديري المخزون والمسؤولين والمالكين؛ ويسجّل المهندسون القطع في مهامهم فقط.`,
      keywords: [
        'حركة مخزون',
        'استلام',
        'صرف',
        'تحويل',
        'تسوية',
        'جرد',
        'قطع مستخدمة',
        'إرجاع قطعة',
        'رقم تسلسلي',
        'ارقام تسلسلية',
        'دفعة',
        'تاريخ انتهاء',
        'تتبع',
      ],
    },
  },
  {
    key: 'purchasing_suppliers_orders_receipts',
    module: 'purchasing',
    feature: 'purchasing',
    minPermission: 'purchasing.read',
    appRoute: 'purchaseOrders',
    public: {
      category: 'stock-assets',
      question: {
        en: 'How do I buy from suppliers and receive goods?',
        ar: 'كيف أشتري من الموردين وأستلم البضائع؟',
      },
    },
    en: {
      title: 'Suppliers, purchase orders, approval and receiving goods',
      summary:
        'Keeping suppliers and their price lists, drafting a purchase order, having it approved, receiving goods into a location, returns and the reorder list.',
      body: `Purchasing sits under the Inventory group once Integr8 has switched the purchasing module on. Suppliers holds who you buy from: name, contact, email, phone, tax reference, payment terms, lead time in days, address, status (Active or Inactive) and notes. A supplier’s Price list says what it charges per item from a quantity on, in its currency, between valid dates; a new order line takes the price in force for its quantity, and you are asked for a price when the list has none.

New purchase order creates a draft for a supplier with an expected date, a Deliver to location and lines: item, description, quantity, unit price and tax. A draft can be edited and is only a draft until an owner or admin chooses Approve, which fixes the lines and lets goods be received against it. Prices are shown to those who manage purchasing or move stock. Statuses are Draft, Approved, Partly received, Received and Cancelled; cancelling keeps what was already received in stock.

Receive goods records an arrival: choose the location to put it in, the supplier’s delivery note or invoice number, and what arrived on each line, with a unit cost when it differs from the order price. An order can be received in several deliveries. Return to supplier takes goods back out of the location they were received into, with a reason. Serial-tracked items ask for their serial numbers or batches on receipt. At the store, the phone’s Receive goods screen receives an approved order by scanning each item as it comes in; it needs a connection.

Reorder, under Inventory, asks which location to bring back to its reorder levels, lists what is short there less what is already on order, rounded up to the supplier’s smallest price break, and Draft purchase orders makes one draft per supplier, each waiting for approval.

Dispatchers, inventory managers, admins and owners add suppliers, draft orders and receive goods; approval is for owners and admins only.`,
      keywords: [
        'purchasing',
        'supplier',
        'vendor',
        'purchase order',
        'po',
        'approve',
        'receive goods',
        'goods receipt',
        'delivery note',
        'return to supplier',
        'price list',
        'reorder',
      ],
    },
    ar: {
      title: 'الموردون وأوامر الشراء والاعتماد واستلام البضائع',
      summary:
        'إدارة الموردين وقوائم أسعارهم، وإعداد أمر شراء، واعتماده، واستلام البضائع في موقع، والمرتجعات، وقائمة إعادة الطلب.',
      body: `تقع المشتريات تحت مجموعة «المخزون» بعد أن تفعّل Integr8 وحدة المشتريات. يضم «الموردون» من تشتري منهم: الاسم وجهة الاتصال والبريد الإلكتروني والهاتف والرقم الضريبي وشروط الدفع ومدة التوريد بالأيام والعنوان والحالة (نشط أو غير نشط) والملاحظات. وتبيّن «قائمة الأسعار» لكل مورّد ما يتقاضاه لكل صنف ابتداءً من كمية معينة، بعملته، بين تاريخي صلاحية؛ ويأخذ بند الأمر الجديد السعر الساري لكميته، ويُطلب منك السعر عندما لا يكون في القائمة.

يُنشئ «أمر شراء جديد» مسودة لمورّد مع تاريخ متوقع وموقع «التسليم إلى» والبنود: الصنف والوصف والكمية وسعر الوحدة والضريبة. يمكن تعديل المسودة وتبقى مسودة حتى يختار المالك أو المسؤول «اعتماد»، فتثبّت البنود ويُسمح باستلام البضائع عليها. وتُعرض الأسعار لمن يديرون المشتريات أو يحرّكون المخزون. الحالات: مسودة، ومعتمد، ومستلم جزئيًا، ومستلم، وملغى؛ والإلغاء يُبقي ما استُلم فعلًا في المخزون.

يسجّل «استلام البضائع» وصول شحنة: اختر الموقع الذي توضع فيه، ورقم إشعار التسليم أو فاتورة المورّد، وما وصل في كل بند، مع تكلفة الوحدة إن اختلفت عن سعر الأمر. ويمكن استلام الأمر على عدة شحنات. و«مرتجع إلى المورّد» يُخرج البضائع من الموقع الذي استُلمت فيه، مع السبب. وتطلب الأصناف المتتبَّعة أرقامها التسلسلية أو دفعاتها عند الاستلام. وفي المخزن، تستلم شاشة «استلام البضائع» على الهاتف أمرًا معتمدًا بمسح كل صنف عند وصوله؛ وتحتاج إلى اتصال.

وتسأل «إعادة الطلب»، تحت المخزون، أي موقع تريد إعادته إلى حدود إعادة الطلب، وتعرض ما ينقصه بعد خصم ما هو مطلوب بالفعل، مقرّبًا لأعلى إلى أصغر شريحة سعرية للمورّد، و«إعداد أوامر الشراء» ينشئ مسودة واحدة لكل مورّد، تنتظر كل منها الاعتماد.

يضيف المنسّقون ومديرو المخزون والمسؤولون والمالكون الموردين ويُعدّون الأوامر ويستلمون البضائع؛ أما الاعتماد فللمالكين والمسؤولين فقط.`,
      keywords: [
        'مشتريات',
        'مورد',
        'موردون',
        'موردين',
        'أمر شراء',
        'اوامر الشراء',
        'اعتماد',
        'استلام البضائع',
        'استلام بضاعة',
        'إشعار تسليم',
        'مرتجع للمورد',
        'قائمة الأسعار',
        'إعادة الطلب',
      ],
    },
  },
  {
    key: 'finance_invoices_credit_notes',
    module: 'finance',
    feature: 'finance',
    minPermission: 'finance.read',
    appRoute: 'invoices',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do I invoice a customer or credit an invoice?',
        ar: 'كيف أصدر فاتورة لعميل أو إشعارًا دائنًا؟',
      },
    },
    en: {
      title: 'Invoices and credit notes',
      summary:
        'Drafting an invoice from scratch, from a sales order or from a completed job, issuing and voiding it, crediting part of it, and the invoice settings.',
      body: `The Finance group appears when Integr8 has switched the finance module on. Invoices lists what customers owe, with their status: Draft, Issued, Part paid, Paid, Credited or Void, and Overdue when the due date has passed. Search by reference or customer, or show Overdue only.

An invoice starts as a draft in one of three ways. New invoice drafts one from scratch for a customer, with lines and notes for the customer. Invoice this order, on a confirmed sales order, drafts from the order and lets you bill everything ordered or only what has been delivered so far; nothing another invoice already bills is billed again. Invoice this job, on a completed job, bills the job: its parts and a labour line worked out from the hours on site and the labour rate per hour in the invoice settings. The job’s Invoicing and cost section also shows hours, parts, labour, cost and an estimated profit for the office.

A draft has no number and can be changed or discarded. Issue, done by an owner or admin, gives the invoice its number, fixes what it says and sets the due date from the company’s days to pay unless you set one. After that an invoice is corrected with a credit note: Credit opens a draft that reduces what the invoice asks for, by chosen lines or Credit everything still owed, and is issued with its own number. Void cancels an issued invoice that nothing has been paid or credited against, with a reason; its number stays used. Print or save as PDF gives the document.

Invoice settings, for owners and admins, hold what is printed about your company: legal name, address, tax reference, how to pay, a footer, days to pay, and the labour cost and labour rate per hour. Every line’s amounts are rounded to the currency’s smallest unit, piastres for the Egyptian pound, and the total is the sum of the rounded lines. Invoices from Integr8 Plus are commercial records, not certified tax documents; sending invoices to the Egyptian Tax Authority is the separate E-invoicing module.

Dispatchers draft invoices and credit notes; issuing, voiding and recording money are for owners and admins. When the ledger is set up, issued documents post to it automatically.`,
      keywords: [
        'invoice',
        'bill',
        'credit note',
        'issue invoice',
        'void',
        'due date',
        'overdue',
        'invoice job',
        'invoice order',
        'labour rate',
        'invoice settings',
        'pdf',
      ],
    },
    ar: {
      title: 'الفواتير والإشعارات الدائنة',
      summary:
        'إعداد فاتورة من البداية أو من أمر بيع أو من مهمة مكتملة، وإصدارها وإلغاؤها، وإصدار إشعار دائن لجزء منها، وإعدادات الفواتير.',
      body: `تظهر مجموعة «المالية» عندما تفعّل Integr8 وحدة المالية. تعرض «الفواتير» ما يدين به العملاء، مع حالة كل فاتورة: مسودة، أو صادرة، أو مدفوعة جزئيًا، أو مدفوعة، أو مُشعَر بها دائنًا، أو ملغاة، و«متأخرة» عندما يمضي تاريخ الاستحقاق. ابحث بالرقم أو العميل، أو اعرض «المتأخرة فقط».

تبدأ الفاتورة مسودةً بإحدى ثلاث طرق. «فاتورة جديدة» تُعدّ فاتورة من البداية لعميل، ببنود وملاحظات للعميل. و«فوترة هذا الأمر»، في أمر بيع مؤكد، تُعدّها من الأمر وتتيح فوترة كل ما طُلب أو ما سُلّم حتى الآن فقط؛ ولا يُفوتَر مجددًا ما فوترته فاتورة أخرى. و«فوترة هذه المهمة»، في مهمة مكتملة، تفوتر المهمة: قطعها وبند عمالة محسوبًا من الساعات في الموقع وأجر الساعة في إعدادات الفواتير. ويعرض قسم «الفوترة والتكلفة» في المهمة أيضًا الساعات والقطع والعمالة والتكلفة وربحًا تقديريًا للمكتب.

المسودة بلا رقم ويمكن تغييرها أو حذفها. و«إصدار»، الذي يقوم به المالك أو المسؤول، يعطي الفاتورة رقمها ويثبّت محتواها ويحدد تاريخ الاستحقاق من أيام السداد المعتادة للشركة ما لم تحدد غيره. وبعد ذلك تُصحَّح الفاتورة بإشعار دائن: يفتح «إشعار دائن» مسودة تخفّض ما تطلبه الفاتورة، ببنود مختارة أو «إشعار بكل المتبقي»، وتُصدر برقمها الخاص. و«إلغاء» يلغي فاتورة صادرة لم يُدفع ولم يُقيَّد عليها شيء، مع السبب؛ ويبقى رقمها مستخدمًا. و«طباعة أو حفظ بصيغة PDF» يعطي المستند.

وتحمل «إعدادات الفواتير»، للمالكين والمسؤولين، ما يُطبع عن شركتك: الاسم القانوني والعنوان والرقم الضريبي وطريقة الدفع وتذييل الصفحة وأيام السداد وتكلفة العمالة وأجر العمالة للساعة. وتُقرَّب مبالغ كل بند إلى أصغر وحدة في العملة، أي القرش للجنيه المصري، والإجمالي هو مجموع البنود المقرّبة. والفواتير من Integr8 Plus سجلات تجارية، لا مستندات ضريبية معتمدة؛ أما إرسال الفواتير إلى مصلحة الضرائب المصرية فهو وحدة الفاتورة الإلكترونية المستقلة.

يُعدّ المنسّقون مسودات الفواتير والإشعارات الدائنة؛ أما الإصدار والإلغاء وتسجيل الأموال فللمالكين والمسؤولين. وعند إعداد دفتر الأستاذ تُرحَّل المستندات الصادرة إليه تلقائيًا.`,
      keywords: [
        'فاتورة',
        'فواتير',
        'إشعار دائن',
        'اشعار دائن',
        'إصدار فاتورة',
        'إلغاء فاتورة',
        'تاريخ الاستحقاق',
        'متأخرة',
        'فوترة مهمة',
        'فوترة أمر بيع',
        'أجر العمالة',
        'إعدادات الفواتير',
      ],
    },
  },
  {
    key: 'finance_payments_allocations',
    module: 'finance',
    feature: 'finance',
    minPermission: 'finance.read',
    appRoute: 'payments',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do I record a payment and put it against invoices?',
        ar: 'كيف أسجّل دفعة وأخصصها للفواتير؟',
      },
    },
    en: {
      title: 'Payments, allocations and customer balances',
      summary:
        'Recording money received, putting it against invoices, money left on account, taking an allocation back, and reading a customer’s balance.',
      body: `Payments, under Finance, lists the money received and the invoices it paid. Record payment asks for the customer, the amount, the date it was received on, the method (Cash, Bank transfer or Other), an optional bank reference and notes. Recorded from an invoice, the payment is put against that invoice straight away and any rest stays on the customer’s account; recorded from the Payments screen, it starts on account until it is allocated.

On a payment’s page, Put against an invoice chooses one of the customer’s issued invoices in the same currency that still owes something, up to the amount left on the payment. Invoices paid lists each allocation with who made it and when. Take back removes an allocation: the invoice owes that amount again and the money returns to the customer’s account. The filter With money on account shows payments that are not fully allocated yet.

An invoice’s Amounts show its total, what was credited, what was paid and what is still owed, and its status moves from Issued to Part paid and Paid as allocations arrive. On a customer’s page, Account shows what they owe, what is on account and the balance, or In credit when payments exceed invoices, with the invoices still owing and the payments with money on account.

Recording and allocating payments is for owners and admins; dispatchers and viewers read them. With the ledger set up, each payment posts automatically to the cash or bank account chosen in the ledger settings, and the Receivables report reconciles the ledger against invoices, credit notes and payments per customer and ages the open invoices by how late they are.`,
      keywords: [
        'payment',
        'receipt',
        'record payment',
        'allocate',
        'on account',
        'unallocated',
        'customer balance',
        'owed',
        'bank transfer',
        'cash',
        'take back',
        'receivables',
      ],
    },
    ar: {
      title: 'المدفوعات والتخصيص وأرصدة العملاء',
      summary:
        'تسجيل الأموال المستلمة، وتخصيصها للفواتير، والمبالغ المتبقية في الحساب، واسترداد تخصيص، وقراءة رصيد العميل.',
      body: `تعرض «المدفوعات»، تحت المالية، الأموال المستلمة والفواتير التي سددتها. يطلب «تسجيل دفعة» العميل والمبلغ وتاريخ الاستلام والطريقة (نقدًا أو تحويل بنكي أو أخرى) ومرجعًا بنكيًا اختياريًا وملاحظات. وعند التسجيل من فاتورة تُخصَّص الدفعة لتلك الفاتورة فورًا ويبقى أي فائض في حساب العميل؛ وعند التسجيل من شاشة المدفوعات تبدأ في الحساب حتى تُخصَّص.

في صفحة الدفعة، يختار «تخصيص لفاتورة» إحدى فواتير العميل الصادرة بالعملة نفسها التي ما يزال عليها مبلغ، بما لا يتجاوز المتبقي من الدفعة. وتعرض «الفواتير المسددة» كل تخصيص مع من أجراه ومتى. و«استرداد» يزيل التخصيص: تعود الفاتورة مدينة بذلك المبلغ ويعود المال إلى حساب العميل. ويعرض عامل التصفية «بها مبلغ في الحساب» الدفعات التي لم تُخصَّص بالكامل بعد.

تعرض «المبالغ» في الفاتورة إجماليها وما قُيّد دائنًا وما دُفع وما يزال مستحقًا، وتنتقل حالتها من صادرة إلى مدفوعة جزئيًا ثم مدفوعة مع وصول التخصيصات. وفي صفحة العميل، يعرض «الحساب» ما يدين به وما في حسابه والرصيد، أو «رصيد دائن» عندما تتجاوز المدفوعات الفواتير، مع الفواتير التي ما تزال مستحقة والدفعات التي بها مبلغ في الحساب.

تسجيل الدفعات وتخصيصها للمالكين والمسؤولين؛ ويقرأها المنسّقون والمشاهدون. ومع إعداد دفتر الأستاذ، تُرحَّل كل دفعة تلقائيًا إلى حساب النقدية أو البنك المختار في إعدادات الدفتر، ويطابق تقرير «المدينون» الدفتر مع الفواتير والإشعارات الدائنة والدفعات لكل عميل ويصنّف الفواتير المفتوحة بحسب مدة تأخرها.`,
      keywords: [
        'دفعة',
        'مدفوعات',
        'تسجيل دفعة',
        'تحصيل',
        'تخصيص',
        'في الحساب',
        'رصيد العميل',
        'مستحق',
        'تحويل بنكي',
        'نقدا',
        'استرداد تخصيص',
        'المدينون',
      ],
    },
  },
  {
    key: 'ledger_setup_journals_unposted',
    module: 'ledger',
    feature: 'ledger',
    minPermission: 'ledger.read',
    appRoute: 'ledger',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do I set up the ledger and post journals?',
        ar: 'كيف أُعدّ دفتر الأستاذ وأرحّل القيود؟',
      },
    },
    en: {
      title: 'The general ledger: set-up, chart of accounts, journals and the unposted list',
      summary:
        'Setting the ledger up, the chart of accounts, opening balances, drafting and posting manual journals, reversals, and documents waiting to be posted.',
      body: `The Accounting group appears when Integr8 has switched the ledger module on. It is a management ledger in your company’s currency, not statutory accounts, and every report says so. An owner or admin sets it up from General ledger by choosing the first month, the month the fiscal year starts in and the language of the chart; a starting chart of accounts is created, which you can rename, recode and add to.

Chart of accounts lists each account with its code, name and type (Asset, Liability, Equity, Income, Expense) and which automatic posting uses it. Enter the opening balances drafts one journal of what the company had and owed on the start date; receivables are filled in from customers’ open invoices and payments.

Journals holds manual journals: New journal takes a date in an open month, a memo and lines with an account, a debit or credit, an optional customer on receivables lines and a note. A draft may be saved out of balance but must balance to be posted. Posting gives the journal its number and fixes it, and is done by someone other than the person who drafted it unless the owner allows self-approval in the ledger settings. A posted journal is corrected only by Reverse, which posts a mirror journal on a date you choose; a draft is discarded.

Issued invoices, credit notes, voids and payments, stock movements, approved and paid expense claims, approved pay runs and completed assembly orders post automatically when their switch is on. Those that cannot wait in the Unposted list with the reason: queued, automatic posting off, recorded before the ledger was set up, in another currency (enter the exchange rate), stock without a cost (write the lines out), its month is locked, waits for its invoice, or failed. Each can be posted as proposed, posted with lines written out, or set aside with a reason; Post all handles everything that can go as proposed.

Reading the ledger needs ledger access, which viewers also hold; posting is for owners and admins.`,
      keywords: [
        'ledger',
        'general ledger',
        'accounting',
        'chart of accounts',
        'journal',
        'post journal',
        'reverse',
        'opening balances',
        'unposted',
        'automatic posting',
        'exchange rate',
        'self-approval',
      ],
    },
    ar: {
      title: 'دفتر الأستاذ العام: الإعداد ودليل الحسابات وقيود اليومية وما ينتظر الترحيل',
      summary:
        'إعداد الدفتر، ودليل الحسابات، والأرصدة الافتتاحية، وإعداد القيود اليدوية وترحيلها، والقيود العكسية، والمستندات التي تنتظر الترحيل.',
      body: `تظهر مجموعة «المحاسبة» عندما تفعّل Integr8 وحدة دفتر الأستاذ. وهو دفتر إداري بعملة شركتك، لا حسابات قانونية، وكل تقرير يقول ذلك. يُعدّه المالك أو المسؤول من «دفتر الأستاذ العام» باختيار الشهر الأول والشهر الذي تبدأ فيه السنة المالية ولغة دليل الحسابات؛ فيُنشأ دليل حسابات مبدئي يمكنك إعادة تسميته وترميزه والإضافة إليه. ولا يُرحَّل شيء مؤرخ قبل البداية، وتنتظر المستندات المسجلة منذ البداية في قائمة ما ينتظر الترحيل.

يعرض «دليل الحسابات» كل حساب برمزه واسمه ونوعه (أصول، خصوم، حقوق ملكية، إيرادات، مصروفات) وأي ترحيل تلقائي يستخدمه. والحساب الذي رُحّل إليه يحتفظ بنوعه، ولا يمكن أرشفة حساب يستخدمه ترحيل تلقائي. و«إدخال الأرصدة الافتتاحية» يُعدّ قيدًا واحدًا بما كانت الشركة تملكه وتدين به في تاريخ البداية؛ وتُعبَّأ ذمم المدينين من فواتير العملاء المفتوحة ودفعاتهم.

تضم «قيود اليومية» القيود اليدوية: يأخذ «قيد جديد» تاريخًا في شهر مفتوح ومذكرة وبنودًا لكل منها حساب ومدين أو دائن وعميل اختياري في بنود المدينين وملاحظة. ويمكن حفظ المسودة غير متوازنة لكن يجب أن تتوازن لتُرحَّل. ويعطي الترحيل القيد رقمه ويثبّته، ويقوم به شخص غير من أعدّه ما لم يسمح المالك بالاعتماد الذاتي في إعدادات الدفتر. ولا يُصحَّح قيد مُرحَّل إلا بـ«قيد عكسي» يرحّل قيدًا معكوسًا بتاريخ تختاره؛ أما المسودة فتُحذف.

تُرحَّل الفواتير الصادرة والإشعارات الدائنة والإلغاءات والدفعات، وحركات المخزون، ومطالبات المصروفات المقبولة والمسدَّدة، ومسيرات الرواتب المعتمدة، وأوامر التجميع المكتملة تلقائيًا عندما يكون مفتاحها مفعّلًا. وما لا يمكن ترحيله ينتظر في «قائمة ما ينتظر الترحيل» مع السبب: في الطابور، أو الترحيل التلقائي متوقف، أو سُجّل قبل إعداد الدفتر، أو بعملة أخرى (أدخل سعر الصرف)، أو مخزون بلا تكلفة (اكتب البنود بنفسك)، أو شهره مقفل، أو ينتظر فاتورته، أو فشل. ويمكن ترحيل كل منها كما هو مقترح، أو ببنود مكتوبة، أو تنحيته جانبًا بسبب؛ و«ترحيل الكل» يعالج كل ما يمكن ترحيله كما هو مقترح.

قراءة الدفتر تحتاج إلى صلاحية الدفتر التي يحملها المشاهدون أيضًا؛ أما الترحيل فللمالكين والمسؤولين.`,
      keywords: [
        'دفتر الأستاذ',
        'دفتر الاستاذ',
        'محاسبة',
        'دليل الحسابات',
        'شجرة الحسابات',
        'قيد يومية',
        'قيود',
        'ترحيل',
        'قيد عكسي',
        'أرصدة افتتاحية',
        'ينتظر الترحيل',
        'سعر الصرف',
      ],
    },
  },
  {
    key: 'ledger_periods_reports_year_end',
    module: 'ledger',
    feature: 'ledger',
    minPermission: 'ledger.read',
    appRoute: 'ledgerReports',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do month locks, reports and year end work?',
        ar: 'كيف يعمل قفل الأشهر والتقارير وإقفال السنة؟',
      },
    },
    en: {
      title: 'Ledger reports, locking months and the year-end close',
      summary:
        'The trial balance, account activity, receivables, profit and loss and balance sheet, locking and unlocking months, and closing or reopening a fiscal year.',
      body: `Ledger reports, under Accounting, offers five reports. Trial balance lists every account’s balance as at a date and says whether debits equal credits. Account activity shows one account’s lines over a range, with the balance brought forward and at the end; only the first 5,000 lines are shown, so narrow the range for a busy account. Receivables reconciles the receivables account per customer against what invoices, credit notes and payments say, ages the open invoices (not yet due, 1–30, 31–60, 61–90 and over 90 days late) and lists payments not yet put against an invoice. Profit and loss totals income and expenses over a range. Balance sheet shows assets, liabilities and equity as at a date, with earnings not yet closed.

Every report counts posted journals only; it says how many draft journals and waiting documents dated in the range were left out. Each can be downloaded as CSV or printed, and each is marked as a management report, not statutory accounts.

Months and years keeps the fiscal years and their months. Lock a month once it is closed: nothing posts into a locked month, and a document dated in one waits in the unposted list until it is posted on another date or the month is unlocked. Only the owner unlocks a month, saying why, and the reason is kept in the month’s history.

Close the year posts a closing journal on the year’s last day that brings every income and expense account to zero against retained earnings, and locks every month of the year. Reopen, for the owner only and with a reason, reverses the closing journal; the months stay locked, so unlock the ones that need work and close the year again afterwards.

Ledger settings, for owners and admins, hold the automatic posting switches for sales, stock, expense claims and payroll, the posting account each uses, and the self-approval setting, which only the owner changes. The start date and fiscal year are fixed once the first journal is posted.`,
      keywords: [
        'trial balance',
        'profit and loss',
        'balance sheet',
        'receivables aging',
        'account activity',
        'lock month',
        'unlock month',
        'period',
        'fiscal year',
        'year end close',
        'reopen year',
        'ledger reports',
      ],
    },
    ar: {
      title: 'تقارير الدفتر وقفل الأشهر وإقفال السنة المالية',
      summary:
        'ميزان المراجعة وحركة الحساب والمدينون والأرباح والخسائر والميزانية العمومية، وقفل الأشهر وفتحها، وإقفال السنة المالية أو إعادة فتحها.',
      body: `تقدّم «تقارير الدفتر»، تحت المحاسبة، خمسة تقارير. يعرض «ميزان المراجعة» رصيد كل حساب في تاريخ معين ويبيّن هل يساوي المدين الدائن. وتعرض «حركة الحساب» بنود حساب واحد خلال فترة، مع الرصيد المرحَّل والرصيد في النهاية؛ ولا يُعرض إلا أول 5000 بند، فضيّق الفترة للحساب كثير الحركة. ويطابق «المدينون» حساب المدينين لكل عميل مع ما تقوله الفواتير والإشعارات الدائنة والدفعات، ويصنّف الفواتير المفتوحة بحسب التأخر (لم تستحق بعد، 1–30، 31–60، 61–90، أكثر من 90 يومًا)، ويعرض الدفعات التي لم تُخصَّص لفاتورة بعد. وتجمع «الأرباح والخسائر» الإيرادات والمصروفات خلال فترة. وتعرض «الميزانية العمومية» الأصول والخصوم وحقوق الملكية في تاريخ معين، مع الأرباح التي لم تُقفل بعد.

كل تقرير يحتسب القيود المرحَّلة فقط؛ ويذكر عدد مسودات القيود والمستندات المنتظرة المؤرخة في الفترة التي استُبعدت. ويمكن تنزيل كل تقرير بصيغة CSV أو طباعته، وكل منها معلَّم كتقرير إداري لا حسابات قانونية.

تحفظ «الأشهر والسنوات» السنوات المالية وأشهرها. اقفل الشهر بعد انتهائه: لا يُرحَّل شيء في شهر مقفل، وينتظر المستند المؤرخ فيه في قائمة ما ينتظر الترحيل حتى يُرحَّل بتاريخ آخر أو يُفتح الشهر. والمالك وحده يفتح الشهر مع ذكر السبب، ويُحفظ السبب في سجل الشهر.

يرحّل «إقفال السنة» قيد إقفال في آخر يوم من السنة يصفّر كل حسابات الإيرادات والمصروفات مقابل الأرباح المحتجزة، ويقفل كل أشهر السنة. و«إعادة الفتح»، للمالك وحده وبسبب، يعكس قيد الإقفال؛ وتبقى الأشهر مقفلة، فافتح ما يحتاج منها إلى عمل ثم أقفل السنة مجددًا.

وتحمل «إعدادات الدفتر»، للمالكين والمسؤولين، مفاتيح الترحيل التلقائي للمبيعات والمخزون ومطالبات المصروفات والرواتب، وحساب الترحيل الذي يستخدمه كل منها، وإعداد الاعتماد الذاتي الذي لا يغيّره إلا المالك. ويثبت تاريخ البداية والسنة المالية بعد ترحيل أول قيد.`,
      keywords: [
        'ميزان المراجعة',
        'الأرباح والخسائر',
        'الميزانية العمومية',
        'أعمار الديون',
        'حركة الحساب',
        'قفل الشهر',
        'فتح الشهر',
        'فترة',
        'سنة مالية',
        'إقفال السنة',
        'إعادة فتح السنة',
        'تقارير الدفتر',
      ],
    },
  },
  {
    key: 'assets_register_tags_warranty',
    module: 'assets',
    feature: 'assets',
    minPermission: 'asset.read',
    appRoute: 'assets',
    public: {
      category: 'stock-assets',
      question: {
        en: 'How do I keep a register of the machines we service?',
        ar: 'كيف أحتفظ بسجل للمعدات التي نخدمها؟',
      },
    },
    en: {
      title: 'Assets: the register, QR tags, service history and warranty alerts',
      summary:
        'Registering the machines you service, printing and scanning their tags, recording condition and moves, linking them to jobs and forms, and warranty alerts.',
      body: `Assets, under Operations, appears when Integr8 has switched the assets module on. It is the register of the machines you service, each at a customer’s site, with its history in one place. New asset asks for the customer and site, a name, make, model, serial number, an optional catalogue item, where on site it is, when it was installed, when its warranty ends and notes. Assets can also be imported from CSV.

Every asset gets a tag code with a QR code. Print tag, or select several and print them together, gives the labels; scanning one opens the asset’s history, and typing the code printed under it does the same. New tag issues a fresh code when a label is lost or damaged, and the old one stops opening the asset.

An asset is In use, Out of service or Retired, and its condition (Good, Fair, Poor or Unusable) is recorded over time with who recorded it. Move to another site keeps the move in the history. Photos and documents can be attached. The History shows when it was registered, its moves, status and condition changes, the jobs it was linked to, the forms submitted for it and the parts fitted to it.

On a job, Assets on this job lists the assets linked to it; Link an asset at this site picks one already registered there, and an engineer can Register an asset found on site from the phone, where it gets its number when sent and the office prints its tag. Fill forms for an asset ties a submission to it, and a form built to carry answers over from the asset’s last visit starts from them. Engineers see the assets at the sites they have a job at; everyone else with asset access sees them all.

Warranty alerts, in the asset settings, say how many days before a warranty ends to warn. Assets inside that window are listed on the Dashboard under Warranties ending soon, carry a badge, and raise one notification on engineers’ phones.`,
      keywords: [
        'asset',
        'equipment',
        'machine',
        'register asset',
        'qr tag',
        'scan tag',
        'print tag',
        'serial number',
        'service history',
        'condition',
        'warranty',
        'warranty alert',
        'out of service',
      ],
    },
    ar: {
      title: 'الأصول: السجل وملصقات QR وسجل الخدمة وتنبيهات الضمان',
      summary:
        'تسجيل المعدات التي تخدمها، وطباعة ملصقاتها ومسحها، وتسجيل الحالة والنقل، وربطها بالمهام والنماذج، وتنبيهات الضمان.',
      body: `تظهر «الأصول»، تحت العمليات، عندما تفعّل Integr8 وحدة الأصول. وهي سجل المعدات التي تخدمها، كل منها في موقع عميل، وسجلها في مكان واحد. يطلب «أصل جديد» العميل والموقع والاسم والشركة المصنّعة والطراز والرقم التسلسلي وصنف كتالوج اختياريًا والمكان في الموقع وتاريخ التركيب وتاريخ انتهاء الضمان والملاحظات. ويمكن أيضًا استيراد الأصول من CSV.

يحصل كل أصل على رمز ملصق برمز QR. ويعطي «طباعة الملصق»، أو تحديد عدة أصول وطباعتها معًا، الملصقات؛ ومسح أحدها يفتح سجل الأصل، وكتابة الرمز المطبوع تحته تفعل الشيء نفسه. و«ملصق جديد» يصدر رمزًا جديدًا عند فقد الملصق أو تلفه، ويتوقف القديم عن فتح الأصل.

الأصل إما قيد الاستخدام أو خارج الخدمة أو مُستبعَد، وتُسجَّل حالته (جيدة، مقبولة، سيئة، غير صالحة للاستخدام) مع مرور الوقت مع اسم من سجّلها. و«نقل إلى موقع آخر» يحفظ النقل في السجل. ويمكن إرفاق صور ومستندات. ويعرض السجل متى سُجّل الأصل، ونقلاته، وتغييرات حالته ووضعه، والمهام التي رُبط بها، والنماذج المرسلة له، والقطع المركّبة فيه.

في المهمة، تعرض «الأصول في هذه المهمة» الأصول المرتبطة بها؛ ويختار «ربط أصل في هذا الموقع» أصلًا مسجلًا فيه، ويستطيع المهندس «تسجيل أصل» وُجد في الموقع من الهاتف، فيحصل على رقمه عند الإرسال ويطبع المكتب ملصقه. ويربط «تعبئة نماذج لهذا الأصل» الإرسال به، والنموذج المبني لنقل الإجابات من الزيارة السابقة للأصل يبدأ منها. يرى المهندسون أصول المواقع التي لديهم مهام فيها؛ ويرى كل من له صلاحية الأصول جميعها.

وتحدد «تنبيهات الضمان»، في إعدادات الأصول، قبل كم يومًا من انتهاء الضمان يُنبَّه. وتُعرض الأصول داخل تلك النافذة في لوحة التحكم تحت «ضمانات تنتهي قريبًا»، وتحمل شارة، وتُطلق إشعارًا واحدًا على هواتف المهندسين.`,
      keywords: [
        'أصل',
        'أصول',
        'اصول',
        'معدات',
        'جهاز',
        'تسجيل أصل',
        'ملصق',
        'رمز qr',
        'مسح الملصق',
        'طباعة ملصق',
        'رقم تسلسلي',
        'سجل الخدمة',
        'ضمان',
        'خارج الخدمة',
      ],
    },
  },
  {
    key: 'hr_employees',
    module: 'hr',
    feature: 'hr',
    minPermission: 'hr.read',
    appRoute: 'employees',
    public: {
      category: 'people-hr',
      question: {
        en: 'What does the HR module keep about employees?',
        ar: 'ماذا تحفظ وحدة الموارد البشرية عن الموظفين؟',
      },
    },
    en: {
      title: 'HR: employee profiles',
      summary:
        'Adding employees whether or not they sign in, job details, protected ID and bank details, ending employment, and My profile.',
      body: `The HR group appears when Integr8 has switched the HR module on. Employees lists everybody the company employs, whether or not they sign in to the apps, searchable by name, employee number, job title or department, and filtered by status (Active or Left) and department.

Add employee starts a profile either for a member of the company who signs in, chosen from the members, or for somebody who does not sign in. The job section holds the employee number, full name, job title, department, phone and hire date. ID and bank details hold the national ID, social insurance number, bank and IBAN. They are stored encrypted, lists show only their last four characters, and Show reveals one in full on request; every reveal is recorded. The emergency contact holds a name and phone. When payroll is on, the profile also holds the person’s pay terms.

End employment records an end date and a reason; the person stays on record with their history, and if they also sign in you suspend or remove them under People as well. Bring back clears the end date so they are active again.

Owners, admins and HR managers see employee profiles. Only the owner and HR managers see and change ID numbers, bank details and pay, and only they add and change profiles; admins see job details without the protected ones. Somebody becomes an HR manager either by holding that role or by the owner choosing Also make HR manager on the People screen.

Everybody has My profile, which shows what the company holds about them as an employee, and asks HR to add a profile when there is none yet.`,
      keywords: [
        'hr',
        'employee',
        'staff',
        'employee profile',
        'national id',
        'bank details',
        'iban',
        'hire date',
        'end employment',
        'department',
        'my profile',
        'hr manager',
      ],
    },
    ar: {
      title: 'الموارد البشرية: ملفات الموظفين',
      summary:
        'إضافة الموظفين سواء سجّلوا الدخول أم لا، وبيانات الوظيفة، وبيانات الهوية والبنك المحمية، وإنهاء الخدمة، و«ملفي الوظيفي».',
      body: `تظهر مجموعة «الموارد البشرية» عندما تفعّل Integr8 وحدة الموارد البشرية. تعرض «الموظفون» كل من تستخدمهم الشركة، سواء سجّلوا الدخول إلى التطبيقات أم لا، ويمكن البحث فيهم بالاسم أو رقم الموظف أو المسمى الوظيفي أو القسم، وتصفيتهم بالحالة (على رأس العمل أو غادر) والقسم.

يبدأ «إضافة موظف» ملفًا إما لعضو في الشركة يسجّل الدخول، يُختار من الأعضاء، أو لشخص لا يسجّل الدخول. يحمل قسم الوظيفة رقم الموظف والاسم الكامل والمسمى الوظيفي والقسم والهاتف وتاريخ التعيين. وتحمل «بيانات الهوية والبنك» الرقم القومي ورقم التأمينات الاجتماعية والبنك ورقم الحساب (IBAN). وتُخزَّن مشفّرة، ولا تعرض القوائم إلا آخر أربعة أحرف منها، ويكشف «إظهار» إحداها كاملة عند الطلب؛ ويُسجَّل كل كشف. وتحمل جهة اتصال الطوارئ اسمًا وهاتفًا. وعند تفعيل الرواتب يحمل الملف أيضًا شروط أجر الشخص.

يسجّل «إنهاء الخدمة» تاريخ انتهاء وسببًا؛ ويبقى الشخص في السجل مع تاريخه، وإن كان يسجّل الدخول أيضًا فأوقفه أو أزله من شاشة الأشخاص كذلك. و«إعادة» يمسح تاريخ الانتهاء ليعود على رأس العمل.

يرى المالكون والمسؤولون ومديرو الموارد البشرية ملفات الموظفين. والمالك ومديرو الموارد البشرية وحدهم يرون أرقام الهوية وبيانات البنك والأجر ويغيّرونها، وهم وحدهم من يضيفون الملفات ويعدّلونها؛ ويرى المسؤولون بيانات الوظيفة دون المحمية منها. ويصبح الشخص مدير موارد بشرية إما بحمل ذلك الدور أو باختيار المالك «جعله أيضًا مدير الموارد البشرية» في شاشة الأشخاص.

ولكل شخص «ملفي الوظيفي» الذي يعرض ما تحتفظ به الشركة عنه بصفته موظفًا، ويطلب من الموارد البشرية إضافة ملف إن لم يكن له ملف بعد.`,
      keywords: [
        'موارد بشرية',
        'موظف',
        'موظفين',
        'ملف الموظف',
        'الرقم القومي',
        'بيانات البنك',
        'رقم الحساب البنكي',
        'تاريخ التعيين',
        'إنهاء الخدمة',
        'قسم',
        'ملفي الوظيفي',
        'مدير الموارد البشرية',
      ],
    },
  },
  {
    key: 'expense_claims',
    module: 'hr',
    feature: 'hr',
    minPermission: null,
    appRoute: 'myExpenses',
    public: {
      category: 'people-hr',
      question: { en: 'How do I claim an expense back?', ar: 'كيف أطالب باسترداد مصروف؟' },
    },
    en: {
      title: 'Expense claims: claiming and approving',
      summary:
        'Claiming back what you spent for the company with the receipts, on the web or the phone, and how claims are approved, rejected and paid back.',
      body: `With the HR module on, everybody can claim expenses. My expenses, under HR, lists your claims; Claim an expense asks for the category, the date spent (today or earlier), the amount in the company’s currency, what it was for, optionally the job it was for, and a photo or PDF of each receipt. Submit claim sends it; the receipts follow, and the claim tells you if one did not arrive so you can send it again. A claim you no longer want is withdrawn; to claim a corrected amount, withdraw it and make a new claim.

On the phone, My expenses works without signal: the claim and its receipt photos are sent when the phone next can. Your recent claims and their answers show when the phone has signal. A part you bought from a merchant for a job is recorded on the job as Bought from a merchant, and claimed back here as an expense.

Statuses are Waiting, Approved, Rejected, Withdrawn and Paid back, and each claim shows its history: who submitted, approved or rejected it, the reason, and how it is being paid back.

Claims to approve, under HR, is for the owner, admins and HR managers. Approve asks how the money comes back: Paid back directly, recorded later from the claim with Record paying back (cash or bank transfer, with a reference), or Paid back with the next pay run, where payroll is on, which adds it to that person’s pay run with nothing more to record. Reject asks for a reason, which the claimant sees. Somebody other than the person who claimed decides.

Expense categories, kept by the same people, say what expenses may be claimed for; each can be tied to a ledger account, and an archived category is no longer offered. When the ledger is set up, approved claims and their repayments post to it.`,
      keywords: [
        'expense',
        'expense claim',
        'reimbursement',
        'claim back',
        'receipt',
        'approve claim',
        'reject claim',
        'paid back',
        'my expenses',
        'claims to approve',
        'category',
        'petty cash',
      ],
    },
    ar: {
      title: 'مطالبات المصروفات: المطالبة والموافقة',
      summary:
        'استرداد ما أنفقته لصالح الشركة مع الإيصالات، من الويب أو الهاتف، وكيف تُقبل المطالبات أو تُرفض وتُسدَّد.',
      body: `مع تفعيل وحدة الموارد البشرية، يستطيع الجميع المطالبة بالمصروفات. تعرض «مصروفاتي»، تحت الموارد البشرية، مطالباتك؛ ويطلب «مطالبة بمصروف» الفئة وتاريخ الإنفاق (اليوم أو قبله) والمبلغ بعملة الشركة والغرض منه، واختياريًا المهمة التي أُنفق لأجلها، وصورة أو ملف PDF لكل إيصال. ويرسله «تقديم المطالبة»؛ وتتبعه الإيصالات، وتخبرك المطالبة إن لم يصل أحدها لتعيد إرساله. والمطالبة التي لم تعد تريدها تُسحب؛ وللمطالبة بمبلغ مصحَّح، اسحبها وقدّم مطالبة جديدة.

على الهاتف، تعمل «مصروفاتي» دون شبكة: تُرسل المطالبة وصور إيصالاتها عندما يتمكن الهاتف من ذلك. وتظهر مطالباتك الأخيرة وردودها عند توفر الشبكة. والقطعة التي اشتريتها من تاجر لمهمة تُسجَّل في المهمة تحت «شراء من تاجر»، ويُطالَب بها هنا كمصروف.

الحالات: بانتظار القرار، ومقبولة، ومرفوضة، ومسحوبة، ومُسدَّدة، وتعرض كل مطالبة سجلها: من قدّمها أو قبلها أو رفضها، والسبب، وكيف تُسدَّد.

«مطالبات للموافقة»، تحت الموارد البشرية، للمالك والمسؤولين ومديري الموارد البشرية. يسأل «قبول» كيف يُعاد المال: تُسدَّد مباشرةً، وتُسجَّل لاحقًا من المطالبة عبر «تسجيل السداد» (نقدًا أو تحويل بنكي، مع مرجع)، أو تُسدَّد مع مسير الرواتب القادم حيث تكون الرواتب مفعّلة، فتُضاف إلى مسير ذلك الشخص دون تسجيل شيء آخر. ويطلب «رفض» سببًا يراه مقدّم المطالبة. ويقرّر المطالبة شخص غير من قدّمها.

وتحدد «فئات المصروفات»، التي يديرها الأشخاص أنفسهم، ما يمكن المطالبة به من مصروفات؛ ويمكن ربط كل فئة بحساب في الدفتر، ولا تُعرض الفئة المؤرشفة. وعند إعداد دفتر الأستاذ تُرحَّل المطالبات المقبولة وسدادها إليه.`,
      keywords: [
        'مصروف',
        'مصروفات',
        'مطالبة مصروفات',
        'استرداد',
        'إيصال',
        'ايصالات',
        'قبول مطالبة',
        'رفض مطالبة',
        'تسديد',
        'مصروفاتي',
        'مطالبات للموافقة',
        'فئة',
        'عهدة',
      ],
    },
  },
  {
    key: 'payroll_rules_pay_runs',
    module: 'payroll',
    feature: 'payroll',
    minPermission: 'payroll.run',
    appRoute: 'payRuns',
    public: {
      category: 'people-hr',
      question: { en: 'How does payroll work?', ar: 'كيف تعمل الرواتب؟' },
    },
    en: {
      title: 'Payroll: rule sets, pay terms, pay runs and payslips',
      summary:
        'Confirming the payroll rules, giving employees pay terms, preparing and approving a month’s pay run, and printing payslips and files.',
      body: `Payroll sits under HR once Integr8 has switched the payroll module on; it needs the HR module too.

Payroll rules holds the figures each run uses from a month on: the income tax bands and personal exemption, the high-income tables, the social insurance rates for employee and employer with the minimum and maximum insurable wage, and the Martyrs’ Fund rate. Add a rule set starts from the 2026 figures; check every figure against the law and your accountant’s advice, then the owner confirms it, saying who checked it and against what. A confirmed set never changes; a correction is a new set from a later month. A run uses the latest set in force for its month: while that set waits for the owner, the run waits too, and from January it must be a set from the new year, so add one even when the figures did not change and have the owner confirm it.

Each employee’s pay terms live on their profile under Pay: basic pay, allowances, whether they are insured and on what wage, standard hours a month, the overtime rate, how they are paid and the date the terms start.

Prepare a run for this month or next proposes a line for everyone employed in the month who has pay terms: basic and allowances, overtime from clocked hours beyond the standard, and the approved expense claims to be paid back with the pay run. Edit a line to type overtime hours, a bonus, a deduction or unpaid days, and Recalculate after changing terms. Set the pay date, which is printed on the payslips. Approve, by the owner or an HR manager other than the person who prepared it, is final: the run never changes afterwards, its claims are paid back, and it posts to the ledger when the ledger is set up.

Payslips and files offers Print payslips in English or Arabic, the insurance report and the bank file; each download is recorded, and the last two need the HR data key, which Integr8 sets on the server. Everybody reads their own under My payslips, on the web and on the phone with a connection. Integr8 calculates pay from the confirmed rule set; the figures must be checked by your accountant, and nothing is filed with the Tax Authority or NOSI.`,
      keywords: [
        'payroll',
        'salary',
        'pay run',
        'payslip',
        'pay terms',
        'payroll rules',
        'tax bands',
        'social insurance',
        'overtime',
        'bonus',
        'deduction',
        'bank file',
        'approve pay run',
      ],
    },
    ar: {
      title: 'الرواتب: قواعد الرواتب وشروط الأجر ومسيرات الرواتب وقسائم الراتب',
      summary:
        'تأكيد قواعد الرواتب، وإعطاء الموظفين شروط أجر، وإعداد مسير رواتب الشهر واعتماده، وطباعة قسائم الرواتب والملفات.',
      body: `تقع الرواتب تحت الموارد البشرية بعد أن تفعّل Integr8 وحدة الرواتب؛ وهي تحتاج إلى وحدة الموارد البشرية أيضًا. و«مسيرات الرواتب» و«قواعد الرواتب» للمالك ومديري الموارد البشرية.

تحمل «قواعد الرواتب» الأرقام التي يستخدمها كل مسير ابتداءً من شهر معين: شرائح ضريبة الدخل والإعفاء الشخصي، وجداول الدخول المرتفعة، ونسب التأمينات الاجتماعية للموظف وصاحب العمل مع الحد الأدنى والأقصى للأجر التأميني، ونسبة صندوق الشهداء. ويبدأ «إضافة مجموعة قواعد» من أرقام 2026 كما تصفها شركات الرواتب؛ فراجع كل رقم مقابل القانون ومشورة محاسبك، ثم يؤكدها المالك مع ذكر من راجعها وبماذا قارنها. والمجموعة المؤكدة لا تتغير أبدًا؛ والتصحيح مجموعة جديدة من شهر لاحق. ويستخدم المسير آخر مجموعة سارية في شهره: فما دامت بانتظار تأكيد المالك ينتظر المسير أيضًا، ومن يناير يجب أن تكون من السنة الجديدة، فأضف مجموعة جديدة ولو لم تتغير الأرقام ودع المالك يؤكدها.

تقع شروط أجر كل موظف في ملفه تحت «الأجر»: الراتب الأساسي والبدلات وهل هو مؤمَّن عليه وعلى أي أجر، والساعات القياسية في الشهر، ومعدل الأجر الإضافي، وطريقة الدفع، وتاريخ بدء الشروط. ومن لا شروط سارية له يُستبعد من المسير ويُعرض اسمه لتضيفها.

يقترح «إعداد مسير» لهذا الشهر أو التالي سطرًا لكل من يعمل في الشهر وله شروط أجر: الأساسي والبدلات، والأجر الإضافي من الساعات المسجلة فوق القياسية، ومطالبات المصروفات المقبولة التي تُسدَّد مع المسير. عدّل السطر لكتابة ساعات إضافية أو مكافأة أو خصم أو أيام غير مدفوعة، و«إعادة الحساب» بعد تغيير الشروط. وحدد تاريخ الدفع الذي يُطبع على القسائم. و«اعتماد»، من المالك أو مدير موارد بشرية غير من أعدّ المسير، نهائي: لا يتغير المسير بعده، وتُسدَّد مطالباته، ويُرحَّل إلى دفتر الأستاذ عند إعداده. ويمكن حذف المسودة.

تقدّم «قسائم الرواتب والملفات» طباعة القسائم بالعربية أو الإنجليزية، وتقرير التأمينات، وملف البنك؛ ويُسجَّل كل تنزيل، ويحتاج الأخيران إلى مفتاح بيانات الموارد البشرية الذي تضبطه Integr8 على الخادم. ويقرأ كل شخص قسائمه تحت «قسائم راتبي»، على الويب وعلى الهاتف مع وجود اتصال. وتحسب Integr8 الأجر من مجموعة القواعد المؤكدة؛ ويجب أن يراجع محاسبك الأرقام، ولا يُقدَّم شيء إلى مصلحة الضرائب أو هيئة التأمينات.`,
      keywords: [
        'رواتب',
        'مرتبات',
        'راتب',
        'مسير رواتب',
        'مسيرات الرواتب',
        'قسيمة راتب',
        'شروط الأجر',
        'قواعد الرواتب',
        'شرائح الضريبة',
        'تأمينات اجتماعية',
        'ساعات إضافية',
        'مكافأة',
        'خصم',
        'اعتماد المسير',
      ],
    },
  },
  {
    key: 'manufacturing_boms_assembly_planning',
    module: 'manufacturing',
    feature: 'manufacturing',
    minPermission: 'manufacturing.read',
    appRoute: 'boms',
    public: {
      category: 'stock-assets',
      question: {
        en: 'How do bills of materials and assembly orders work?',
        ar: 'كيف تعمل قوائم المواد وأوامر التجميع؟',
      },
    },
    en: {
      title: 'Manufacturing: bills of materials, assembly orders and material planning',
      summary:
        'Describing what an item is built from, assembling or disassembling it with an order that moves stock, and running a plan that says what to build and buy.',
      body: `Manufacturing sits under the Inventory group once Integr8 has switched the manufacturing module on; it works on top of the inventory module. Bills of materials, Assembly orders and Material planning are read by everybody with manufacturing access and kept by owners, admins and inventory managers.

A bill of materials says what one unit of a stock item is built from: its components with a quantity per unit, plus labour and overhead per unit. The bill shows the cost of one unit, worked out from what the components cost now. Saving the bill makes a new version and keeps the one before it for the orders drafted from it; a version is never changed. Retire stops the item being built until a new version is saved.

New assembly order drafts an order to Assemble or Disassemble an item at a location, with a quantity, a planned date and a note. What it takes compares what the order needs with what the location holds, less what is reserved for sales orders, and says what is short. A draft moves nothing. Complete takes the components out and brings the item in (or the reverse for a disassembly) and cannot be undone; it is refused while stock is short. If the output item is tracked, you name the serial numbers or batch made. An order drafted from an older bill keeps that version unless you choose Use the current bill.

Material planning answers what to build and buy. Run a plan for a number of days ahead reads confirmed sales orders, draft assembly orders and reorder levels and lists suggestions level by level: Build or Buy, the quantity, when it is needed by, when to order by given lead times, and the preferred supplier. Choose the lines and Draft orders: assembly orders are drafted, and purchase orders too when you hold purchasing rights and the items have a preferred supplier, each waiting for approval.`,
      keywords: [
        'manufacturing',
        'bill of materials',
        'bom',
        'components',
        'assembly',
        'assembly order',
        'disassemble',
        'build',
        'material planning',
        'mrp',
        'what to buy',
        'lead time',
      ],
    },
    ar: {
      title: 'التصنيع: قوائم المواد وأوامر التجميع وتخطيط المواد',
      summary:
        'وصف ما يُصنع منه الصنف، وتجميعه أو تفكيكه بأمر يحرّك المخزون، وتشغيل خطة تحدد ما يجب تصنيعه وشراؤه.',
      body: `يقع التصنيع تحت مجموعة «المخزون» بعد أن تفعّل Integr8 وحدة التصنيع؛ وهو يعمل فوق وحدة المخزون. ويقرأ «قوائم المواد» و«أوامر التجميع» و«تخطيط المواد» كل من له صلاحية التصنيع، ويديرها المالكون والمسؤولون ومديرو المخزون.

تبيّن قائمة المواد ممَّ تُصنع الوحدة الواحدة من صنف مخزني: مكوّناتها بكمية لكل وحدة، إضافة إلى العمالة والتكاليف غير المباشرة لكل وحدة. وتعرض القائمة تكلفة الوحدة الواحدة محسوبة مما تكلّفه المكوّنات الآن. وحفظ القائمة ينشئ إصدارًا جديدًا ويحتفظ بالذي قبله للأوامر التي أُعدّت منه؛ ولا يتغير الإصدار أبدًا. و«إيقاف» يوقف تصنيع الصنف حتى يُحفظ إصدار جديد.

يُعدّ «أمر تجميع جديد» أمرًا لتجميع صنف أو تفكيكه في موقع، بكمية وتاريخ مخطط وملاحظة. ويقارن «ما يحتاجه» ما يحتاجه الأمر بما يحمله الموقع، بعد خصم المحجوز لأوامر البيع، ويبيّن النقص. والمسودة لا تحرّك شيئًا. و«إتمام» يُخرج المكوّنات ويُدخل الصنف (أو العكس في التفكيك) ولا يمكن التراجع عنه؛ ويُرفض ما دام المخزون ناقصًا. وإذا كان الصنف الناتج متتبَّعًا فإنك تسمّي الأرقام التسلسلية أو الدفعة المصنوعة. والأمر المعدّ من قائمة أقدم يحتفظ بذلك الإصدار ما لم تختر «استخدام القائمة الحالية».

ويجيب «تخطيط المواد» عمّا يجب تصنيعه وشراؤه. يقرأ «تشغيل خطة» لعدد من الأيام القادمة أوامر البيع المؤكدة ومسودات أوامر التجميع وحدود إعادة الطلب ويعرض الاقتراحات مستوى بمستوى: تصنيع أو شراء، والكمية، وموعد الحاجة، وموعد الطلب بحسب مدد التوريد، والمورّد المفضّل. اختر الأسطر ثم «إعداد الأوامر»: تُعدّ أوامر التجميع، وأوامر الشراء أيضًا عندما تحمل صلاحية المشتريات وللأصناف مورّد مفضّل، وينتظر كل منها الاعتماد.`,
      keywords: [
        'تصنيع',
        'قائمة مواد',
        'قوائم المواد',
        'مكونات',
        'تجميع',
        'أمر تجميع',
        'اوامر التجميع',
        'تفكيك',
        'تخطيط المواد',
        'ما يجب شراؤه',
        'مدة التوريد',
        'إنتاج',
      ],
    },
  },
  {
    key: 'subscription_plans_billing',
    module: 'subscription',
    feature: null,
    minPermission: 'billing.read',
    appRoute: 'billing',
    public: {
      category: 'account-billing',
      question: {
        en: 'How are we billed, and what do the plan limits mean?',
        ar: 'كيف تتم فوترتنا، وماذا تعني حدود الخطة؟',
      },
    },
    en: {
      title: 'Your subscription: plans, limits, billing and read-only',
      summary:
        'The four plans, what the Billing screen shows, invoicing by Integr8 (there are no card payments in the app), the seat, submission and storage limits, and storage over the plan.',
      body: `Every company is on one of four plans: Trial, Starter, Standard or Enterprise. Each plan allows a number of people (seats), a number of submissions a month and an amount of storage. Integr8 sets what each plan allows, and can give your company its own number of seats in place of the plan’s. Billing, under Company in the web app, shows your plan, its limits and your usage against them; owners and admins can read it.

Integr8 invoices every company directly. The Billing screen says Invoiced by Integr8: there is no card to add and nothing to pay in the app. To change your plan, add seats or ask about an invoice, contact Integr8, who make plan changes from their dashboard.

The limits are enforced by the system itself. Every active person takes a seat, whatever their role; a suspended person and an invitation not yet accepted do not. Inviting somebody, accepting an invitation and letting a suspended person back in are refused once the seats are used up. Starting a form, and submitting one, are refused once the month’s submissions are used up; corrections to reopened submissions are never counted. A warning appears before each limit is reached.

Storage depends on the plan. On Trial and Starter, uploads are refused once storage is full. On Standard, uploads keep working past the allowance: the Storage screen shows Over your plan, and the extra is added to your Integr8 invoice as the month’s average overage in GB-months, which is the storage over the line each day, averaged over the days of the month. Delete files you no longer need, or ask Integr8 about a larger plan.

An unpaid invoice is followed up by Integr8 directly; nothing is ever deleted for non-payment, and Integr8 can export all of your company’s data for you whenever you ask.

Modules such as CRM, inventory or finance, and the AI assistant, are enabled by Integr8 per company; ask your Integr8 contact.`,
      keywords: [
        'subscription',
        'plan',
        'billing',
        'trial',
        'starter',
        'standard',
        'enterprise',
        'read-only',
        'payment failed',
        'seats',
        'submission limit',
        'storage limit',
        'invoiced by integr8',
        'upgrade',
        'invoiced',
        'overage',
        'over your plan',
      ],
    },
    ar: {
      title: 'اشتراكك: الخطط والحدود والفوترة ووضع القراءة فقط',
      summary:
        'الخطط الأربع، وما تعرضه شاشة الفوترة، والفوترة من Integr8 (لا مدفوعات بالبطاقة في التطبيق)، وحدود المقاعد والإرسالات والتخزين، وتجاوز مساحة الخطة.',
      body: `كل شركة على إحدى أربع خطط: التجريبية، أو المبتدئة، أو القياسية، أو المؤسسات. وتسمح كل خطة بعدد من الأشخاص (المقاعد) وعدد من الإرسالات شهريًا ومساحة تخزين. وتحدد Integr8 ما تسمح به كل خطة، ويمكنها أن تمنح شركتك عددًا خاصًا من المقاعد بدل عدد الخطة. وتعرض «الفوترة»، تحت مجموعة الشركة في تطبيق الويب، خطتك وحدودها واستخدامك منها؛ ويقرؤها المالكون والمسؤولون.

تُصدر Integr8 فواتير كل شركة مباشرةً. وتقول شاشة الفوترة «بفاتورة من Integr8»: لا بطاقة تُضاف ولا شيء يُدفع في التطبيق. ولتغيير خطتك أو إضافة مقاعد أو الاستفسار عن فاتورة، تواصل مع Integr8، فهي التي تغيّر الخطط من لوحة التحكم الخاصة بها.

ويفرض النظام الحدود بنفسه. يشغل كل شخص نشط مقعدًا مهما كان دوره؛ ولا يشغله الشخص الموقوف ولا الدعوة التي لم تُقبل بعد. وتُرفض دعوة شخص، وقبول الدعوة، والسماح بعودة شخص موقوف، بعد استنفاد المقاعد. ويُرفض بدء نموذج، وإرساله، بعد استنفاد إرسالات الشهر؛ ولا تُحتسب أبدًا تصحيحات الإرسالات المعاد فتحها. ويظهر تحذير قبل بلوغ كل حد.

ويعتمد التخزين على الخطة. في الخطتين التجريبية والمبتدئة تُرفض عمليات التحميل عندما يمتلئ التخزين. وفي الخطة القياسية يستمر التحميل بعد تجاوز المساحة المخصصة: تعرض شاشة «التخزين» «تجاوزت مساحة خطتك»، وتُضاف الزيادة إلى فاتورة Integr8 بمتوسط التجاوز خلال الشهر بوحدة غيغابايت-شهر، أي المساحة الزائدة كل يوم بمتوسطها على أيام الشهر. احذف الملفات التي لم تعد بحاجة إليها، أو اسأل Integr8 عن خطة أكبر.

وتتابع Integr8 الفاتورة غير المسددة معك مباشرةً؛ ولا يُحذف شيء أبدًا بسبب عدم الدفع، ويمكن لـ Integr8 أن تصدّر لك كل بيانات شركتك متى طلبت.

والوحدات مثل إدارة علاقات العملاء أو المخزون أو المالية، والمساعد الذكي، تفعّلها Integr8 لكل شركة؛ فتواصل مع جهة اتصالك في Integr8.`,
      keywords: [
        'اشتراك',
        'خطة',
        'الخطط',
        'فوترة',
        'تجريبية',
        'مبتدئة',
        'قياسية',
        'مؤسسات',
        'قراءة فقط',
        'فشل الدفع',
        'مقاعد',
        'حد الإرسالات',
        'حد التخزين',
        'ترقية',
        'فاتورة',
        'تجاوز المساحة',
      ],
    },
  },
  {
    key: 'account_sign_in_troubleshooting',
    module: 'troubleshooting',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'account-billing',
      question: {
        en: 'I cannot sign in. What should I do?',
        ar: 'لا أستطيع تسجيل الدخول. ماذا أفعل؟',
      },
    },
    en: {
      title: 'Signing in, locked accounts, invitations and devices',
      summary:
        'What to do when you cannot sign in, a forgotten password (an emailed sign-in code), changing your password, a locked account, an invitation link that no longer works, an expired session and signed-in devices.',
      body: `Sign in with the email address your company invited and your password. The same message, that the address and password did not match, is shown for a wrong password, an unknown address and an account with no company, on purpose. Check the address and try again.

If you have forgotten your password, type your email address and choose Email me a sign-in code. If the address has an account, an email arrives with a 6-digit code; enter it on the next screen to sign in. The code lasts 15 minutes and works once, and Send a new code replaces it. If nothing arrives, check the spam folder, make sure you are using the address you were invited with, and ask whoever administers your company to confirm it. You can ask for one code a minute and five an hour.

To set a new password, open the account menu and choose Change password. You need your current password, except in the 15 minutes after signing in with an emailed code, when the screen does not ask for it. Changing your password signs out every other device you are signed in on, in every company, including a phone working offline, and emails your address to say the password was changed. If you get that email and did not change it, ask whoever administers your company for help at once.

After too many failed attempts the account is locked for a few minutes; wait and try again. Too many requests in a short time are also slowed down.

Joining is done through an invitation link. On the Join your team page a new person gives their name and chooses a password, following the rules shown; somebody who already has an Integr8 Plus account, from another company, is not asked for one. Joining does not sign you in: the page says you are done, and you then sign in with your email address, which is already filled in. A link that was used, withdrawn or expired no longer works; ask the person who invited you to open People and choose Send again. You cannot be invited while the company has used all the seats its plan allows.

Your session has expired means you need to sign in again; nothing is lost. Suspended or removed people are refused entry and should speak to an owner or admin. A company’s own phone app refuses an account from another company. If you belong to several companies, Switch company moves between them.

Your devices lists where you are signed in, and Sign out this device signs one of them out. Owners and admins can sign out any device in the company, so report a lost phone to them immediately: the phone stops the next time it has signal. The mobile app also has an App lock that locks after five minutes away and opens with your fingerprint, face or the phone’s passcode.

If Integr8 has made the company’s account read-only, signing in works but saving does not; an owner can ask Integr8 why.`,
      keywords: [
        'sign in',
        'login',
        'cannot sign in',
        'forgot password',
        'reset password',
        'change password',
        'sign-in code',
        'email code',
        'locked',
        'too many attempts',
        'invitation',
        'invite link',
        'session expired',
        'devices',
        'lost phone',
        'suspended',
      ],
    },
    ar: {
      title: 'تسجيل الدخول والحسابات المقفلة والدعوات والأجهزة',
      summary:
        'ما تفعله عندما يتعذر تسجيل الدخول، أو تنسى كلمة المرور، أو يُقفل الحساب، أو يتوقف رابط الدعوة، أو تنتهي الجلسة، وعرض الأجهزة المسجلة الدخول.',
      body: `سجّل الدخول بعنوان البريد الإلكتروني الذي دعتك إليه شركتك وكلمة مرورك. تظهر الرسالة نفسها، وهي أن العنوان وكلمة المرور غير متطابقين، لكلمة مرور خاطئة أو عنوان غير معروف أو حساب بلا شركة، وذلك عن قصد. تحقق من العنوان وحاول مجددًا.

إذا نسيت كلمة المرور، فاكتب عنوان بريدك الإلكتروني واختر «أرسل لي رمز تسجيل الدخول بالبريد الإلكتروني». إذا كان للعنوان حساب، تصلك رسالة فيها رمز من 6 أرقام؛ أدخله في الشاشة التالية لتسجيل الدخول. صلاحية الرمز 15 دقيقة ويعمل مرة واحدة، و«أرسل رمزًا جديدًا» يستبدله. وإن لم يصل شيء، فراجع مجلد الرسائل غير المرغوبة، وتأكد من استخدام العنوان الذي دُعيت به، واطلب من مسؤول شركتك التأكد منه. يمكنك طلب رمز واحد كل دقيقة وخمسة في الساعة.

لتعيين كلمة مرور جديدة، افتح قائمة الحساب واختر «تغيير كلمة المرور». تحتاج إلى كلمة المرور الحالية، إلا خلال الدقائق الخمس عشرة التي تلي تسجيل الدخول برمز البريد الإلكتروني، إذ لا تطلبها الشاشة. ويؤدي تغيير كلمة المرور إلى تسجيل خروجك من جميع أجهزتك الأخرى في كل الشركات، بما فيها هاتف يعمل دون اتصال، وتصل إلى بريدك رسالة تخبرك بتغيير كلمة المرور. وإذا وصلتك هذه الرسالة ولم تغيّرها أنت، فاطلب المساعدة فورًا من مسؤول شركتك.

بعد محاولات فاشلة كثيرة يُقفل الحساب بضع دقائق؛ فانتظر وحاول مجددًا. وتُبطَّأ أيضًا الطلبات الكثيرة في وقت قصير.

يتم الانضمام عبر رابط دعوة. في صفحة «انضم إلى فريقك» يكتب الشخص الجديد اسمه ويختار كلمة مرور وفق القواعد المعروضة؛ أما من لديه حساب Integr8 Plus بالفعل من شركة أخرى فلا يُطلب منه ذلك. ولا يسجّل الانضمام دخولك: تخبرك الصفحة بأنك انتهيت، ثم تسجّل الدخول ببريدك الإلكتروني المعبّأ مسبقًا. والرابط الذي استُخدم أو سُحب أو انتهت صلاحيته لم يعد يعمل؛ فاطلب ممن دعاك أن يفتح «الأشخاص» ويختار «إعادة الإرسال». ولا يمكن دعوتك ما دامت الشركة قد استنفدت المقاعد التي تسمح بها خطتها.

«انتهت صلاحية جلستك» تعني أن عليك تسجيل الدخول مجددًا؛ ولا يُفقد شيء. والأشخاص الموقوفون أو المزالون يُمنعون من الدخول وعليهم مراجعة المالك أو المسؤول. ويرفض تطبيق الهاتف الخاص بالشركة حسابًا من شركة أخرى. وإن كنت تنتمي إلى عدة شركات، ينقلك «تبديل الشركة» بينها.

تعرض «أجهزتك» أين أنت مسجّل الدخول، و«تسجيل الخروج من هذا الجهاز» يُخرج أحدها. ويستطيع المالكون والمسؤولون إخراج أي جهاز في الشركة، فأبلغهم فورًا عن هاتف مفقود: يتوقف الهاتف عند أول اتصال له بالشبكة. وفي تطبيق الهاتف أيضًا «قفل التطبيق» الذي يقفل بعد خمس دقائق من الابتعاد ويُفتح ببصمتك أو وجهك أو رمز الهاتف.

وإذا جعلت Integr8 حساب الشركة للقراءة فقط، فتسجيل الدخول يعمل لكن الحفظ لا يعمل؛ ويستطيع المالك سؤال Integr8 عن السبب.`,
      keywords: [
        'تسجيل الدخول',
        'تسجيل دخول',
        'لا أستطيع الدخول',
        'نسيت كلمة المرور',
        'كلمة السر',
        'تغيير كلمة المرور',
        'رمز تسجيل الدخول',
        'حساب مقفل',
        'محاولات كثيرة',
        'دعوة',
        'رابط الدعوة',
        'انتهت الجلسة',
        'الأجهزة',
        'هاتف مفقود',
        'موقوف',
      ],
    },
  },
  {
    key: 'apps_web_desktop_mobile',
    module: 'overview',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'getting-started',
      question: {
        en: 'Which app should I use: web, desktop or phone?',
        ar: 'أي تطبيق أستخدم: الويب أم سطح المكتب أم الهاتف؟',
      },
    },
    en: {
      title: 'The web, desktop and mobile apps: which to use for what',
      summary:
        'What each of the three apps is for, which screens exist only in one of them, and how the apps are built and branded for your company.',
      body: `Integr8 Plus comes as three apps that share one account and the same data.

The web app runs in a browser and is where the office works: the Dashboard, Work orders, Customers, Submissions, Timesheets, imports, assets and every module your company has. Some screens exist only on the web: Get set up, People, Company settings, Storage and Billing, all under Company. Signing in needs a connection, and the web app has no offline mode.

The desktop app, for Windows and macOS, has the same office screens with native menus and a right-click menu on rows. Two screens exist only there, under Set-up: Forms, where forms are built, previewed, tested and published, and Company branding. Both are used by Integr8 staff, who sign in through the Integr8 staff tab, choose your company and say why they are opening it, which the company can read. Owners and admins can look at the forms but not change them; branding is not shown to the company at all.

The mobile app is for engineers. It holds their jobs, customers, sites, forms and files on the phone, works without signal and sends work when there is one. It is where jobs are travelled to, worked, photographed, signed off and completed, parts are used, assets are scanned and expenses are claimed. It is built for your company by Integr8, carries your logo, colours and app icon, and refuses an account from another company. Owners, admins and dispatchers normally do not need it; they do everything in the browser.

The desktop apps update themselves when Integr8 releases a new version. When a desktop or phone app is too old for the server, it says so and offers Update, which opens your company’s download page with the latest installers and the phone app.

All three apps are in English and Arabic, with a right-to-left layout in Arabic, and open in a light or dark theme or follow the device. Every screen in the web and desktop apps is reached from the side menu, grouped under Overview, Work, CRM, Sales, Finance, Accounting, HR, Inventory, Operations, Set-up and Company; a group you cannot see is one your role or your company’s modules do not include.`,
      keywords: [
        'web app',
        'desktop app',
        'mobile app',
        'browser',
        'windows',
        'mac',
        'android',
        'iphone',
        'which app',
        'download app',
        'install',
        'language',
        'arabic',
        'dark mode',
      ],
    },
    ar: {
      title: 'تطبيقات الويب وسطح المكتب والهاتف: أيها تستخدم ولماذا',
      summary:
        'الغرض من كل تطبيق من التطبيقات الثلاثة، والشاشات الموجودة في أحدها فقط، وكيف تُبنى التطبيقات وتحمل هوية شركتك.',
      body: `يأتي Integr8 Plus في ثلاثة تطبيقات تتشارك حسابًا واحدًا والبيانات نفسها.

يعمل تطبيق الويب في المتصفح وهو حيث يعمل المكتب: لوحة التحكم، وأوامر العمل، والعملاء، والإرسالات، وسجلات الدوام، والاستيراد، والأصول، وكل وحدة لدى شركتك. وبعض الشاشات موجودة على الويب فقط: ابدأ الإعداد، والأشخاص، وإعدادات الشركة، والتخزين، والفوترة، وكلها تحت مجموعة الشركة. ويحتاج تسجيل الدخول إلى اتصال، ولا يوجد في تطبيق الويب وضع دون اتصال.

ولتطبيق سطح المكتب، لنظامي Windows وmacOS، شاشات المكتب نفسها مع قوائم أصلية وقائمة بالنقر الأيمن على الصفوف. وهناك شاشتان موجودتان فيه فقط، تحت مجموعة الإعداد: «النماذج»، حيث تُبنى النماذج وتُعاين وتُختبر وتُنشر، و«هوية الشركة». ويستخدمهما موظفو Integr8 الذين يسجّلون الدخول من تبويب «موظفو Integr8» ويختارون شركتك ويذكرون سبب فتحها، ويمكن للشركة قراءته. ويستطيع المالكون والمسؤولون الاطلاع على النماذج دون تغييرها؛ أما هوية الشركة فلا تُعرض للشركة أصلًا.

وتطبيق الهاتف للمهندسين. يحمل مهامهم وعملاءهم ومواقعهم ونماذجهم وملفاتهم على الهاتف، ويعمل دون شبكة ويرسل العمل عند توفرها. وفيه يُنطلق إلى المهام وتُنفَّذ وتُصوَّر ويعتمدها العميل وتُتم، وتُستخدم القطع، وتُمسح الأصول، ويُطالَب بالمصروفات. وتبنيه Integr8 لشركتك، فيحمل شعارك وألوانك وأيقونة تطبيقك، ويرفض حسابًا من شركة أخرى. ولا يحتاج إليه المالكون والمسؤولون والمنسّقون عادةً؛ فهم يفعلون كل شيء في المتصفح.

وتحدّث تطبيقات سطح المكتب نفسها عندما تُصدر Integr8 نسخة جديدة. وعندما يصبح تطبيق سطح المكتب أو الهاتف أقدم مما يقبله الخادم، يخبرك بذلك ويعرض «تحديث» الذي يفتح صفحة التنزيل الخاصة بشركتك مع أحدث برامج التثبيت وتطبيق الهاتف.

والتطبيقات الثلاثة بالعربية والإنجليزية، مع تخطيط من اليمين إلى اليسار بالعربية، وتُفتح بسمة فاتحة أو داكنة أو تتبع الجهاز. وكل شاشة في تطبيقي الويب وسطح المكتب تُفتح من القائمة الجانبية المقسّمة إلى: نظرة عامة، والعمل، وإدارة علاقات العملاء، والمبيعات، والمالية، والمحاسبة، والموارد البشرية، والمخزون، والعمليات، والإعداد، والشركة؛ والمجموعة التي لا تراها هي مجموعة لا يشملها دورك أو وحدات شركتك.`,
      keywords: [
        'تطبيق الويب',
        'تطبيق سطح المكتب',
        'تطبيق الهاتف',
        'الموبايل',
        'المتصفح',
        'ويندوز',
        'ماك',
        'اندرويد',
        'ايفون',
        'أي تطبيق',
        'تحميل التطبيق',
        'تثبيت',
        'اللغة',
        'الوضع الداكن',
      ],
    },
  },
  {
    key: 'company_settings',
    module: 'account',
    feature: null,
    minPermission: 'tenant.update',
    appRoute: 'companySettings',
    public: {
      category: 'account-billing',
      question: {
        en: 'What can I change in Company settings?',
        ar: 'ما الذي يمكنني تغييره في إعدادات الشركة؟',
      },
    },
    en: {
      title: 'Company settings: timezone, currency, language, working hours and branding',
      summary:
        'What the owner sets under Company settings, what each setting affects, and which parts of the company’s look are set by Integr8.',
      body: `Company settings, under Company in the web app, is for the owner and applies to everybody in the company.

Where you are holds three settings. Timezone decides what a working day means for the company: due windows, timesheets, the dates on reports and the dates in a CSV import without a time zone are all read in it. Currency is the company’s currency: item costs, quotes and invoices, expense claims, pay and the ledger are kept in it, and a quote or lead in another currency says so. The currency can be changed only until the company has its first money record, such as an item cost, a quote, an invoice, a payment, an expense or a pay run; after that it is fixed. Default language is the language the apps use for the company, English or Arabic; each reader still sees the screens in their own language where the app offers it. Phone notifications arrive in the phone’s own language, or the company’s default language when the phone has not said.

Working hours sets when the day starts and ends and which days are working days; the screen warns when no working day is selected. A new company starts on Cairo time (Africa/Cairo) with Sunday to Thursday as its working days.

Branding is in two parts. The logo and brand colour under Company settings are printed on the documents you send out, such as quotes, invoices and delivery notes; the logo is a PNG, JPEG or WebP up to the size shown, and the brand colour is six hex digits. How your company looks inside its apps, on the other hand, is set by Integr8: the logo in the menu, the accent and shell colours, the default theme, the website link and the icon of your phone and desktop apps. The screen says Integr8 sets how your company looks in its apps; to change any of it, contact your Integr8 contact.

Other settings live with their modules and are kept by owners and admins: Invoice settings under Finance (legal name, tax reference, how to pay, days to pay, labour rates), Ledger settings under Accounting, Warranty alerts under Assets, Expense categories under HR, and the Pipelines of the CRM. Job types and forms are set up by Integr8. Storage, under Company, shows what the company uses by kind and how much is left on its plan. Website access, under Company, is where owners and admins choose what the company’s own website may look up.`,
      keywords: [
        'company settings',
        'timezone',
        'currency',
        'language',
        'default language',
        'working hours',
        'working days',
        'logo',
        'brand colour',
        'branding',
        'theme',
        'settings',
        'currency locked',
        'notifications language',
        'working days',
      ],
    },
    ar: {
      title: 'إعدادات الشركة: المنطقة الزمنية والعملة واللغة وساعات العمل والهوية',
      summary:
        'ما يضبطه المالك تحت إعدادات الشركة، وما يؤثر فيه كل إعداد، وأي أجزاء مظهر الشركة تضبطها Integr8.',
      body: `«إعدادات الشركة»، تحت مجموعة الشركة في تطبيق الويب، للمالك وتسري على الجميع في الشركة.

يحمل قسم «أين أنتم» ثلاثة إعدادات. المنطقة الزمنية تحدد معنى يوم العمل للشركة: نوافذ الاستحقاق، وسجلات الدوام، وتواريخ التقارير، وتواريخ الاستيراد من CSV التي بلا منطقة زمنية تُقرأ كلها بها. والعملة هي عملة الشركة: تكاليف الأصناف، وعروض الأسعار والفواتير، ومطالبات المصروفات، والأجور، ودفتر الأستاذ تُحفظ بها، ويُذكر ذلك على عرض سعر أو عميل محتمل بعملة أخرى. ولا يمكن تغيير العملة إلا قبل أول سجل مالي للشركة، مثل تكلفة صنف أو عرض سعر أو فاتورة أو دفعة أو مصروف أو مسيرة رواتب؛ وبعدها تثبت. واللغة الافتراضية هي اللغة التي تستخدمها التطبيقات للشركة، العربية أو الإنجليزية؛ ويبقى كل قارئ يرى الشاشات بلغته حيث يتيح التطبيق ذلك. وتصل إشعارات الهاتف بلغة الهاتف نفسه، أو باللغة الافتراضية للشركة إن لم يحدد الهاتف لغته.

وتحدد «ساعات العمل» متى يبدأ اليوم وينتهي وأي الأيام أيام عمل؛ وتحذّر الشاشة عندما لا يُختار أي يوم عمل. وتبدأ الشركة الجديدة بتوقيت القاهرة (Africa/Cairo) وأيام عمل من الأحد إلى الخميس.

والهوية جزآن. الشعار ولون العلامة تحت إعدادات الشركة يُطبعان على المستندات التي ترسلها، مثل عروض الأسعار والفواتير وإشعارات التسليم؛ والشعار ملف PNG أو JPEG أو WebP حتى الحجم المبيّن، ولون العلامة ستة أحرف سداسية عشرية. أما مظهر شركتك داخل تطبيقاتها فتضبطه Integr8: الشعار في القائمة، ولونا التمييز والإطار، والسمة الافتراضية، ورابط الموقع الإلكتروني، وأيقونة تطبيقات الهاتف وسطح المكتب. وتقول الشاشة إن Integr8 تحدد مظهر شركتك في تطبيقاتها؛ ولتغيير أي منه، تواصل مع جهة اتصالك في Integr8.

وتقع الإعدادات الأخرى مع وحداتها ويديرها المالكون والمسؤولون: إعدادات الفواتير تحت المالية (الاسم القانوني والرقم الضريبي وطريقة الدفع وأيام السداد وأجور العمالة)، وإعدادات الدفتر تحت المحاسبة، وتنبيهات الضمان تحت الأصول، وفئات المصروفات تحت الموارد البشرية، ومسارات المبيعات في إدارة علاقات العملاء. وأنواع المهام والنماذج تُعدّها Integr8. وتعرض «التخزين»، تحت الشركة، ما تستخدمه الشركة بحسب النوع وما تبقّى لها في خطتها. وفي «وصول الموقع»، تحت الشركة، يختار المالكون والمسؤولون ما يمكن لموقع الشركة الإلكتروني البحث عنه.`,
      keywords: [
        'إعدادات الشركة',
        'اعدادات',
        'المنطقة الزمنية',
        'العملة',
        'اللغة',
        'اللغة الافتراضية',
        'ساعات العمل',
        'أيام العمل',
        'شعار',
        'لون العلامة',
        'هوية الشركة',
        'السمة',
        'قفل العملة',
        'لغة الإشعارات',
        'أيام العمل',
      ],
    },
  },
  {
    key: 'ai_assistant',
    module: 'overview',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'getting-started',
      question: { en: 'What can the AI assistant do?', ar: 'ماذا يستطيع المساعد الذكي أن يفعل؟' },
    },
    en: {
      title: 'The AI assistant: what it can do and its limits',
      summary:
        'What the in-app assistant can do (answer from the help guide, look up your records, prepare changes you confirm), where it appears, who switches it on, and its limits.',
      body: `The assistant answers questions about how to use Integr8 Plus: what a screen is for, where to find something, which button does what, who may do what, and what to do when something is refused. It answers in English or Arabic from reviewed help articles like this one, and shows the articles it used so you can read more. When the help does not cover a question, it says so rather than guessing, and points you to Integr8.

What else it can do depends on the level your company’s plan includes. At the help level it only answers from the guide. With insights it can also look your company’s records up to answer a question, such as overdue jobs, a customer’s summary, open quotes, invoices, stock on hand, the CRM pipeline or your own schedule, only as far as your role and your company’s modules let you see them, and it changes nothing. With actions it can also prepare a new customer, a new work order, a CRM follow-up or an opportunity’s move to another stage: nothing is saved until you check the card it shows and confirm it, a proposal lapses after five minutes, and the change is recorded as made by you through the assistant.

When the assistant runs without a language model, or the model is unavailable, it answers from the help guide alone and says so.

The assistant is online only. It is not part of the work the mobile app keeps on the phone, so it is unavailable without signal, and it is unavailable while the company’s account is read-only. Never type passwords, card numbers or other secrets into it; it does not need them, and it never asks for them.

Whether your company has the assistant at all is decided by Integr8 as part of your subscription plan, and it is off until Integr8 switches it on for the company. Within that, the company’s owner or admins decide in which apps it appears (web, desktop, mobile) and which people may use it. If you do not see it, ask an owner or admin first, and they ask Integr8.

Your plan sets how many assistant messages the company, and each person, may send a day and a month; days and months are counted in UTC. When a limit is reached, the assistant says so and the count starts again at the next day or month. Only a message that was actually answered counts; a question that failed is not charged. Whether conversations are kept, and for how long, is also part of the plan: when history is off, every question stands alone and nothing is kept beyond the reply.`,
      keywords: [
        'ai assistant',
        'assistant',
        'chatbot',
        'help bot',
        'ask',
        'limit',
        'messages per day',
        'quota',
        'offline',
        'enable assistant',
        'turn on ai',
        'not available',
        'insights',
        'actions',
        'confirm',
        'records',
      ],
    },
    ar: {
      title: 'المساعد الذكي: ما يستطيعه وحدوده',
      summary:
        'ما يستطيع المساعد داخل التطبيق فعله (الإجابة من دليل المساعدة، والبحث في سجلاتك، وتحضير تغييرات تؤكدها)، وأين يظهر، ومن يفعّله، وحدوده.',
      body: `يجيب المساعد عن أسئلة حول كيفية استخدام Integr8 Plus: ما الغرض من شاشة، وأين تجد شيئًا، وماذا يفعل كل زر، ومن يستطيع فعل ماذا، وماذا تفعل عندما يُرفض شيء. ويجيب بالعربية أو الإنجليزية من مقالات مساعدة مراجَعة مثل هذه، ويعرض المقالات التي استند إليها لتقرأ المزيد. وعندما لا يغطي محتوى المساعدة سؤالًا، يقول ذلك بدل التخمين ويوجّهك إلى Integr8.

وما يستطيعه غير ذلك يعتمد على المستوى الذي تشمله خطة شركتك. في مستوى المساعدة يجيب من الدليل فقط. ومع «الرؤى» يستطيع أيضًا البحث في سجلات شركتك للإجابة عن سؤال، مثل المهام المتأخرة، أو ملخص عميل، أو عروض الأسعار المفتوحة، أو الفواتير، أو المخزون المتوفر، أو مسار المبيعات، أو جدولك أنت، وذلك فقط في حدود ما يسمح لك دورك ووحدات شركتك برؤيته، ولا يغيّر شيئًا. ومع «الإجراءات» يستطيع أيضًا تحضير عميل جديد، أو أمر عمل جديد، أو متابعة في إدارة علاقات العملاء، أو نقل فرصة إلى مرحلة أخرى: لا يُحفظ شيء حتى تراجع البطاقة التي يعرضها وتؤكدها، وينتهي الاقتراح بعد خمس دقائق، ويُسجَّل التغيير على أنك أجريته عبر المساعد.

وعندما يعمل المساعد دون نموذج لغوي، أو يكون النموذج غير متاح، يجيب من دليل المساعدة وحده ويقول ذلك.

يعمل المساعد عبر الاتصال فقط. فهو ليس جزءًا من العمل الذي يحتفظ به تطبيق الهاتف على الهاتف، ولذلك لا يتوفر دون شبكة، ولا يتوفر عندما يكون حساب الشركة للقراءة فقط. ولا تكتب فيه أبدًا كلمات مرور أو أرقام بطاقات أو أسرارًا أخرى؛ فهو لا يحتاج إليها ولا يطلبها أبدًا.

وما إذا كان لدى شركتك المساعد أصلًا تقرره Integr8 ضمن خطة اشتراكك، وهو متوقف حتى تفعّله Integr8 للشركة. وضمن ذلك، يقرر مالك الشركة أو مسؤولوها في أي التطبيقات يظهر (الويب، سطح المكتب، الهاتف) ومن يستطيع استخدامه. وإن لم تره، فاسأل المالك أو المسؤول أولًا، وهم يسألون Integr8.

وتحدد خطتك عدد رسائل المساعد التي يمكن للشركة، ولكل شخص، إرسالها في اليوم وفي الشهر؛ وتُحسب الأيام والأشهر بالتوقيت العالمي (UTC). وعند بلوغ الحد يخبرك المساعد بذلك ويبدأ العدّ مجددًا مع اليوم أو الشهر التالي. ولا تُحتسب إلا الرسالة التي أُجيب عنها فعلًا؛ والسؤال الذي فشل لا يُحتسب. وما إذا كانت المحادثات تُحفظ، ولكم من الوقت، جزء من الخطة أيضًا: عندما يكون السجل متوقفًا، يقف كل سؤال وحده ولا يُحفظ شيء بعد الرد.`,
      keywords: [
        'المساعد الذكي',
        'مساعد',
        'الذكاء الاصطناعي',
        'شات بوت',
        'روبوت المساعدة',
        'اسأل',
        'حد الرسائل',
        'رسائل في اليوم',
        'حصة',
        'دون اتصال',
        'تفعيل المساعد',
        'غير متاح',
        'الرؤى',
        'الإجراءات',
        'تأكيد',
        'السجلات',
      ],
    },
  },
  {
    key: 'documents_pdfs_upload_sharing',
    module: 'documents',
    feature: 'documents',
    minPermission: 'document.read',
    appRoute: 'documents',
    public: {
      category: 'forms-documents',
      question: {
        en: 'How do PDF documents work, and who can see them?',
        ar: 'كيف تعمل مستندات PDF، ومن يستطيع رؤيتها؟',
      },
    },
    en: {
      title: 'Documents: PDFs from submissions, uploaded PDFs and sharing',
      summary:
        'The register of PDF documents, making a PDF from a submission, uploading a PDF made elsewhere, the QR code link, and Sharing, which decides whether anybody outside the company can open a document.',
      body: `Documents, under Work, appears when Integr8 has switched the documents module on. It is the company’s register of PDF documents: certificates and reports made from submissions, and PDFs you upload yourself. Search by any of a document’s fields or its title, filter by state, and open, view or download the PDF.

To make a PDF from a submission, open the submission and choose Make PDF, pick one of the form’s PDF templates (Integr8 designs them with you) and fill in anything the template asks for. The PDF is made in a moment, and its page updates by itself.

To add a PDF made elsewhere, such as a certificate signed on paper and scanned, choose Upload a PDF in Documents: a PDF of up to 20 MB, a title, a reference number such as the certificate number, and optionally the customer it belongs to. An uploaded document is listed in the same register, marked Uploaded, and has its own QR code link like any other.

Every document has a Sharing section, with Share it and Stop sharing. While a document is shared, its QR code link opens the PDF for anybody who has the link, without an account, and your company’s own website can find the document by its reference. When it is not shared (marked Not shared in the register), the link and the website lookup both stop, and the document stays in the register for your team. New documents start not shared; documents made before sharing could be switched stay shared. Every change is recorded in the document’s history.

Stop the link and Open the link again stop or restart a document’s link, and a date can stop it by itself. Delete stops the link at once and removes the PDF after the restore window. Uploading documents and sharing them are for owners and admins unless your company’s roles say otherwise; making a PDF also needs access to the submission.`,
      keywords: [
        'documents',
        'pdf',
        'certificate',
        'upload',
        'uploaded',
        'qr code',
        'link',
        'shareable',
        'share',
        'website lookup',
        'make pdf',
        'template',
        'expire',
      ],
    },
    ar: {
      title: 'المستندات: ملفات PDF من الإرسالات والملفات المرفوعة و«المشاركة»',
      summary:
        'سجل مستندات PDF، وإنشاء PDF من إرسال، ورفع PDF أُنشئ في مكان آخر، ورابط رمز QR، وقسم «المشاركة» الذي يحدد هل يستطيع أحد من خارج الشركة فتح المستند.',
      body: `تظهر «المستندات»، تحت مجموعة العمل، عندما تفعّل Integr8 وحدة المستندات. وهي سجل الشركة لمستندات PDF: الشهادات والتقارير المنشأة من الإرسالات، وملفات PDF التي ترفعها بنفسك. ابحث بأي حقل من حقول المستند أو بعنوانه، وصفِّ بالحالة، وافتح ملف PDF أو اعرضه أو نزّله.

لإنشاء PDF من إرسال، افتح الإرسال واختر «إنشاء PDF»، ثم اختر أحد قوالب PDF الخاصة بالنموذج (تصممها Integr8 معك) واملأ ما يطلبه القالب. يُنشأ الملف خلال لحظات، وتتحدّث صفحته تلقائيًا.

ولإضافة PDF أُنشئ في مكان آخر، مثل شهادة موقّعة على الورق ثم مُسحت ضوئيًا، اختر «رفع ملف PDF» في «المستندات»: ملف PDF حتى 20 ميغابايت، وعنوان، ورقم مرجعي مثل رقم الشهادة، والعميل الذي يخصه إن أردت. ويظهر المستند المرفوع في السجل نفسه بعلامة «مرفوع»، وله رابط رمز QR خاص به كأي مستند آخر.

ولكل مستند قسم «المشاركة»، وفيه «شاركه» و«أوقف المشاركة». ما دام المستند مُشارَكًا، يفتح رابط رمز QR الخاص بالمستند ملف PDF لكل من لديه الرابط دون حساب، ويستطيع موقع شركتك الإلكتروني العثور على المستند برقمه المرجعي. وعندما يكون غير مُشارَك (وعليه علامة «غير مُشارَك» في السجل)، يتوقف الرابط والبحث من الموقع كلاهما، ويبقى المستند في السجل لفريقك. تبدأ المستندات الجديدة غير مُشارَكة؛ أما المستندات المنشأة قبل إمكانية إيقاف المشاركة فتبقى مُشارَكة. ويُسجَّل كل تغيير في سجل المستند.

ويوقف «إيقاف الرابط» و«فتح الرابط مجددًا» رابط المستند أو يعيدان تشغيله، ويمكن لتاريخ أن يوقفه تلقائيًا. ويوقف «حذف» الرابط فورًا ويزيل ملف PDF بعد فترة الاستعادة. ورفع المستندات ومشاركتها للمالكين والمسؤولين ما لم تحدد أدوار شركتك غير ذلك؛ ويحتاج إنشاء PDF أيضًا إلى صلاحية الوصول إلى الإرسال.`,
      keywords: [
        'المستندات',
        'PDF',
        'شهادة',
        'رفع',
        'مرفوع',
        'رمز QR',
        'رابط',
        'قابل للمشاركة',
        'مشاركة',
        'البحث من الموقع',
        'إنشاء PDF',
        'قالب',
        'إيقاف الرابط',
      ],
    },
  },
  {
    key: 'e_invoicing_eta',
    module: 'e_invoicing',
    feature: 'e_invoicing',
    minPermission: 'eta.read',
    appRoute: 'eInvoicing',
    public: null,
    en: {
      title: 'E-invoicing with the Egyptian Tax Authority',
      summary:
        'What the e-invoicing module does, its settings and codes, preparing, signing and sending an invoice to the ETA, what each state means, and what is not yet validated.',
      body: `E-invoicing sends the company’s issued invoices to the Egyptian Tax Authority (ETA) as e-invoices, signed with the company’s own token. It needs the finance module, and Integr8 switches it on for a company from the staff desktop app. It appears under Finance as E-invoicing.

Owners and admins set it up under Settings: the environment (PreProd for testing, or Production), the issuer details, the company’s ETA credentials, which are never shown again once saved, and the signing certificates. Codes holds the customers’ tax identities, the items’ ETA codes and the unit and tax mappings, which the people who prepare documents keep.

From an issued invoice choose Prepare ETA document, then Ask for signature. Signing is done in the desktop app on the computer the company’s token is plugged into: open the signing queue, check the document and sign it. Then choose Send to the ETA. A document moves through Ready to sign, Waiting for signature, Signed, Sending and Sent, awaiting the ETA, and ends Valid, Invalid or Rejected; the status is checked automatically, and Check status now asks at once. An invalid or rejected document shows what the ETA said in its own words: correct the invoice or the codes, then prepare it again. When no clear answer came back, search the ETA portal for the invoice before choosing Say what happened, because sending a document the ETA already has creates a duplicate.

A valid document can be cancelled at the ETA, and its ETA PDF downloaded. E-invoicing has not yet been tested end to end with the live tax authority, and signing needs the token’s driver on the desktop computer; keep it on the test system until Integr8 says it is ready.`,
      keywords: [
        'e-invoicing',
        'einvoice',
        'eta',
        'egyptian tax authority',
        'tax',
        'sign',
        'token',
        'signing queue',
        'submit',
        'valid',
        'invalid',
        'rejected',
        'preprod',
        'codes',
      ],
    },
    ar: {
      title: 'الفاتورة الإلكترونية مع مصلحة الضرائب المصرية',
      summary:
        'ما تفعله وحدة الفاتورة الإلكترونية، وإعداداتها ورموزها، وتحضير الفاتورة وتوقيعها وإرسالها إلى المصلحة، ومعنى كل حالة، وما لم يُتحقق منه بعد.',
      body: `ترسل الفاتورة الإلكترونية فواتير الشركة الصادرة إلى مصلحة الضرائب المصرية (ETA) كفواتير إلكترونية موقّعة بتوكن الشركة نفسها. وتحتاج إلى وحدة المالية، وتفعّلها Integr8 للشركة من تطبيق سطح المكتب الخاص بموظفيها. وتظهر تحت المالية باسم «الفاتورة الإلكترونية».

يُعدّها المالكون والمسؤولون من «الإعدادات»: البيئة (PreProd للاختبار، أو الإنتاج)، وبيانات المُصدِر، وبيانات اعتماد الشركة لدى المصلحة التي لا تُعرض مجددًا بعد حفظها، وشهادات التوقيع. وتضم «الرموز» الهويات الضريبية للعملاء، ورموز الأصناف لدى المصلحة، ومطابقة الوحدات والضرائب، ويتولاها من يحضّرون المستندات.

من فاتورة صادرة اختر «تحضير مستند للمصلحة»، ثم «طلب التوقيع». ويتم التوقيع في تطبيق سطح المكتب على الحاسوب الموصول به توكن الشركة: افتح طابور التوقيع، وراجع المستند، ووقّعه. ثم اختر «الإرسال إلى المصلحة». ويمر المستند بالحالات: جاهز للتوقيع، وبانتظار التوقيع، وموقّع، وقيد الإرسال، وأُرسل بانتظار المصلحة، وينتهي صالحًا أو غير صالح أو مرفوضًا؛ وتُفحص الحالة تلقائيًا، ويسأل «فحص الحالة الآن» فورًا. ويعرض المستند غير الصالح أو المرفوض ما قالته المصلحة بكلماتها: صحّح الفاتورة أو الرموز ثم حضّر المستند مجددًا. وعندما لا يعود جواب واضح، ابحث عن الفاتورة في بوابة المصلحة قبل اختيار «اذكر ما حدث»، لأن إرسال مستند موجود لدى المصلحة ينشئ نسخة مكررة.

ويمكن إلغاء المستند الصالح لدى المصلحة وتنزيل ملف PDF الخاص بها. ولم تُختبر الفاتورة الإلكترونية بعد اختبارًا كاملًا مع المصلحة الفعلية، ويحتاج التوقيع إلى برنامج تشغيل التوكن على حاسوب سطح المكتب؛ فأبقها على بيئة الاختبار حتى تخبرك Integr8 بأنها جاهزة.`,
      keywords: [
        'الفاتورة الإلكترونية',
        'مصلحة الضرائب',
        'ضرائب',
        'توقيع',
        'توكن',
        'طابور التوقيع',
        'إرسال',
        'صالح',
        'غير صالح',
        'مرفوض',
        'بيئة الاختبار',
        'الرموز',
      ],
    },
  },
  {
    key: 'schedule_visits',
    module: 'work_orders',
    feature: null,
    minPermission: 'work_order.read_all',
    appRoute: 'schedule',
    public: {
      category: 'field-work',
      question: { en: 'How do I plan visits on the schedule?', ar: 'كيف أخطط الزيارات في الجدول؟' },
    },
    en: {
      title: 'The schedule: planning visits',
      summary:
        'Planning when work happens and who goes: visits, the day, week and month calendar, jobs that need a visit, moving and resizing visits, and qualification warnings.',
      body: `Schedule, under Work, is where visits are planned: when the work happens and who goes. A job can have one visit or several, for example a survey and then an installation, each with its own start, length and people. The calendar shows a day, a week or a month, with each person’s visits and the visits with nobody on them yet.

Needs a visit lists open jobs with no planned visit: drag one onto the calendar, or choose Plan a visit and set the time and the people. Drag a visit to move it, and drag its bottom edge to change its length. Select several visits to move or reassign them together. Cancelled visits are hidden unless you choose to show them.

Times are shown in your device’s time zone, and the screen says when that differs from the company’s. When a job needs a skill or certificate that nobody on the visit holds for the visit’s dates, the schedule says who lacks what; you can still go ahead by giving a reason, which is kept in the job’s history.

Engineers see their visits on the phone under Today and Your jobs. Dispatchers, admins and owners plan and change visits; others who can see every job can read the schedule but not change it.`,
      keywords: [
        'schedule',
        'calendar',
        'visit',
        'visits',
        'plan a visit',
        'needs a visit',
        'dispatch board',
        'drag',
        'day',
        'week',
        'month',
        'reassign',
        'time zone',
      ],
    },
    ar: {
      title: 'الجدول: تخطيط الزيارات',
      summary:
        'تخطيط موعد العمل ومن يذهب إليه: الزيارات، والتقويم باليوم والأسبوع والشهر، والمهام التي تحتاج إلى زيارة، ونقل الزيارات وتغيير مدتها، وتنبيهات المؤهلات.',
      body: `«الجدول»، تحت مجموعة العمل، هو حيث تُخطَّط الزيارات: متى يتم العمل ومن يذهب إليه. يمكن أن تكون للمهمة زيارة واحدة أو أكثر، مثل معاينة ثم تركيب، لكل منها بدايتها ومدتها وأشخاصها. ويعرض التقويم يومًا أو أسبوعًا أو شهرًا، مع زيارات كل شخص والزيارات التي لا أحد عليها بعد.

تعرض «تحتاج إلى زيارة» المهام المفتوحة التي لا زيارة مخططة لها: اسحب إحداها إلى التقويم، أو اختر «تخطيط زيارة» وحدد الوقت والأشخاص. اسحب الزيارة لنقلها، واسحب حافتها السفلى لتغيير مدتها. وحدد عدة زيارات لنقلها أو إعادة إسنادها معًا. وتُخفى الزيارات الملغاة ما لم تختر إظهارها.

تُعرض الأوقات بالمنطقة الزمنية لجهازك، وتذكر الشاشة متى تختلف عن منطقة الشركة. وعندما تحتاج المهمة إلى مهارة أو شهادة لا يحملها أحد على الزيارة في تواريخها، يذكر الجدول من ينقصه ماذا؛ ويمكنك المتابعة مع ذكر سبب يُحفظ في سجل المهمة.

ويرى المهندسون زياراتهم على الهاتف تحت «اليوم» و«مهامك». ويخطط المنسّقون والمسؤولون والمالكون الزيارات ويغيّرونها؛ ويستطيع غيرهم ممن يرون كل المهام قراءة الجدول دون تغييره.`,
      keywords: [
        'الجدول',
        'التقويم',
        'زيارة',
        'الزيارات',
        'تخطيط زيارة',
        'تحتاج إلى زيارة',
        'لوحة التوجيه',
        'سحب',
        'يوم',
        'أسبوع',
        'شهر',
        'إعادة إسناد',
        'المنطقة الزمنية',
      ],
    },
  },
  {
    key: 'qualifications_skills_certificates',
    module: 'work_orders',
    feature: null,
    minPermission: null,
    appRoute: 'qualifications',
    public: {
      category: 'people-hr',
      question: {
        en: 'How do we keep track of skills and certificates?',
        ar: 'كيف نتابع المهارات والشهادات؟',
      },
    },
    en: {
      title: 'Skills and certificates',
      summary:
        'Keeping who is qualified for what, the jobs that need a qualification, the warning when nobody on a visit holds it, and expiry alerts.',
      body: `Skills and certificates, under Work, keeps what each person in the company is qualified for. A skill does not expire; a certificate has a number, an issue date, an expiry date and, if you like, a scan. It works without the HR module.

The company’s list holds the skills and certificates you use, and People’s records shows who holds what: Valid, Expiring soon, Expired or Does not expire. Owners, admins and HR managers add and change both; dispatchers and others with access read them, and everybody sees their own, on the phone too.

A job type can list the qualifications its jobs need, and each new job copies that list; it can be changed on a single job. When people are put on a visit, at least one of them must hold each qualification, valid on the visit’s dates rather than today. If nobody does, the schedule and the job say who is missing what, people without it are listed last when choosing the crew, and you can go ahead with a reason that is kept in the job’s history. Nothing is blocked.

Before a certificate runs out, its holder and the managers are warned; the warning period is a company setting, 30 days unless you change it. When a certificate lapses, the warning lists the planned visits that no longer meet what their jobs need.`,
      keywords: [
        'skills',
        'certificates',
        'qualifications',
        'qualified',
        'expiry',
        'expiring',
        'expired',
        'requirement',
        'job type',
        'override',
        'reason',
        'licence',
        'training',
      ],
    },
    ar: {
      title: 'المهارات والشهادات',
      summary:
        'متابعة من هو مؤهل لماذا، والمهام التي تحتاج إلى مؤهل، والتنبيه عندما لا يحمله أحد على الزيارة، وتنبيهات انتهاء الصلاحية.',
      body: `تحفظ «المهارات والشهادات»، تحت مجموعة العمل، ما يؤهَّل له كل شخص في الشركة. المهارة لا تنتهي صلاحيتها؛ والشهادة لها رقم وتاريخ إصدار وتاريخ انتهاء، ونسخة ممسوحة ضوئيًا إن أردت. وتعمل دون وحدة الموارد البشرية.

تضم «قائمة الشركة» المهارات والشهادات التي تستخدمونها، وتعرض «سجلات الأشخاص» من يحمل ماذا: صالحة، أو تنتهي قريبًا، أو منتهية، أو لا تنتهي. ويضيفها المالكون والمسؤولون ومديرو الموارد البشرية ويغيّرونها؛ ويقرؤها المنسّقون وغيرهم ممن لديهم صلاحية، ويرى كل شخص ما يخصه، على الهاتف أيضًا.

يمكن لنوع المهمة أن يذكر المؤهلات التي تحتاجها مهامه، وتنسخ كل مهمة جديدة هذه القائمة؛ ويمكن تغييرها في مهمة واحدة. وعند إسناد أشخاص إلى زيارة، يجب أن يحمل أحدهم على الأقل كل مؤهل، صالحًا في تواريخ الزيارة لا اليوم. وإن لم يحمله أحد، يذكر الجدول والمهمة من ينقصه ماذا، ويُعرض من لا يحمله في آخر القائمة عند اختيار الفريق، ويمكنك المتابعة مع سبب يُحفظ في سجل المهمة. لا شيء يُمنع.

وقبل انتهاء صلاحية الشهادة يُنبَّه حاملها والمديرون؛ ومدة التنبيه إعداد للشركة، 30 يومًا ما لم تغيّرها. وعندما تنتهي الشهادة، يذكر التنبيه الزيارات المخططة التي لم تعد تستوفي ما تحتاجه مهامها.`,
      keywords: [
        'المهارات',
        'الشهادات',
        'المؤهلات',
        'مؤهل',
        'انتهاء الصلاحية',
        'تنتهي قريبًا',
        'منتهية',
        'متطلبات',
        'نوع المهمة',
        'تجاوز',
        'سبب',
        'رخصة',
        'تدريب',
      ],
    },
  },
  {
    key: 'contracts_maintenance_deadlines',
    module: 'work_orders',
    feature: null,
    minPermission: null,
    appRoute: 'contracts',
    public: {
      category: 'field-work',
      question: {
        en: 'How do contracts, maintenance plans and response deadlines work?',
        ar: 'كيف تعمل العقود وخطط الصيانة ومهل الاستجابة؟',
      },
    },
    en: {
      title: 'Service contracts, maintenance plans and response deadlines',
      summary:
        'Recording what a customer has agreed to and whether each job is covered, recurring maintenance jobs for an asset, and the company’s response and completion deadlines.',
      body: `Service contracts, under Operations, record what a customer has agreed to: the customer and sites it covers, its dates and what is included. Each job then says whether it is covered by a contract or chargeable, in the office and on the phone, and office staff can change a job’s coverage with a reason. Nothing is billed or quoted automatically. Contracts are renewed by hand: you are reminded before the end date, and Renew makes a new contract that starts the day after the old one ends, linked to it, with its maintenance plans moved across. A cancelled contract cannot be changed or renewed. Owners, admins and dispatchers keep contracts.

Maintenance, under Work, makes recurring jobs for an asset, so it needs the assets module. A plan names the asset, the job type and an interval, every so many days, weeks, months or years, counted either on a fixed calendar from its start date or from when the last job was completed. A set number of days before each due date, 30 unless you change it, the plan creates the job with its due window, and the job appears under Needs a visit on the Schedule for a dispatcher to place and staff. A plan can be paused or ended, and changing it only affects jobs it has not created yet. Plans linked to an ended contract stop creating jobs.

Response deadlines, under Work, set for each priority how long the company has to respond to a job, which means dispatching it, and to complete it, counted from when the job was created, either around the clock or in working hours only. The clock never pauses. Jobs show their deadlines, a warning goes out before one is missed, and a deadline met late is recorded as a miss in the job’s history. Owners and admins set the deadlines; the report is open to everybody who sees every job.`,
      keywords: [
        'contract',
        'service contract',
        'covered',
        'chargeable',
        'coverage',
        'renew',
        'maintenance',
        'maintenance plan',
        'recurring',
        'planned maintenance',
        'deadline',
        'response time',
        'sla',
        'priority',
      ],
    },
    ar: {
      title: 'عقود الخدمة وخطط الصيانة ومهل الاستجابة',
      summary:
        'تسجيل ما اتفق عليه العميل وهل كل مهمة مشمولة، ومهام الصيانة المتكررة لأصل، ومهل الشركة للاستجابة والإتمام.',
      body: `تسجّل «عقود الخدمة»، تحت مجموعة العمليات، ما اتفق عليه العميل: العميل والمواقع التي يشملها العقد، وتواريخه، وما يتضمنه. وعندها تذكر كل مهمة هل هي مشمولة بعقد أم بمقابل، في المكتب وعلى الهاتف، ويستطيع موظفو المكتب تغيير شمول المهمة مع ذكر سبب. ولا يُفوتَر شيء ولا يُسعَّر تلقائيًا. وتُجدَّد العقود يدويًا: تُذكَّر قبل تاريخ الانتهاء، وينشئ «تجديد» عقدًا جديدًا يبدأ في اليوم التالي لانتهاء القديم ومرتبطًا به، وتنتقل إليه خطط الصيانة. ولا يمكن تغيير العقد الملغى أو تجديده. ويتولى العقود المالكون والمسؤولون والمنسّقون.

تنشئ «الصيانة»، تحت مجموعة العمل، مهامًا متكررة لأصل، ولذلك تحتاج إلى وحدة الأصول. تحدد الخطة الأصل ونوع المهمة وفاصلًا زمنيًا، كل عدد من الأيام أو الأسابيع أو الأشهر أو السنوات، يُحسب إما بتقويم ثابت من تاريخ بدايتها أو من إتمام آخر مهمة. وقبل كل تاريخ استحقاق بعدد محدد من الأيام، 30 ما لم تغيّره، تنشئ الخطة المهمة بنافذة استحقاقها، فتظهر تحت «تحتاج إلى زيارة» في الجدول ليضعها المنسّق ويحدد فريقها. ويمكن إيقاف الخطة مؤقتًا أو إنهاؤها، ولا يؤثر تغييرها إلا في المهام التي لم تُنشأ بعد. وتتوقف الخطط المرتبطة بعقد منتهٍ عن إنشاء المهام.

وتحدد «مهل الاستجابة»، تحت مجموعة العمل، لكل أولوية المدة المتاحة للشركة للاستجابة للمهمة، أي توجيهها، ولإتمامها، محسوبة من وقت إنشاء المهمة، إما على مدار الساعة أو في ساعات العمل فقط. ولا يتوقف العدّ أبدًا. وتعرض المهام مهلها، ويصدر تنبيه قبل فوات المهلة، وتُسجَّل المهلة التي تحققت متأخرة على أنها فائتة في سجل المهمة. ويحدد المالكون والمسؤولون المهل؛ والتقرير متاح لكل من يرى كل المهام.`,
      keywords: [
        'عقد',
        'عقد خدمة',
        'مشمول',
        'بمقابل',
        'الشمول',
        'تجديد',
        'الصيانة',
        'خطة صيانة',
        'متكررة',
        'صيانة دورية',
        'مهلة',
        'وقت الاستجابة',
        'اتفاقية مستوى الخدمة',
        'الأولوية',
      ],
    },
  },
  {
    key: 'closed_jobs_late_phone_work',
    module: 'work_orders',
    feature: null,
    minPermission: null,
    appRoute: 'workOrders',
    public: {
      category: 'phone-app',
      question: {
        en: 'What happens to work a phone sends after the job was closed?',
        ar: 'ماذا يحدث للعمل الذي يرسله الهاتف بعد إغلاق المهمة؟',
      },
    },
    en: {
      title: 'Closed jobs and work a phone sends late',
      summary:
        'What a completed, reviewed or cancelled job refuses, how forms and parts recorded on a phone before the job closed are still accepted, and billing parts that arrive after the invoice.',
      body: `A job that is Complete, Reviewed or Cancelled is closed. A closed job refuses new work from the office: no form can be started on it, a draft cannot be submitted on it, and no parts can be recorded on it from the office screens. Returning unused parts is still allowed.

Phones work without signal, so an engineer may have done the work in time and synced only after the job closed. The phone’s work is judged by when it was done. A form the phone started before the job closed is accepted, marked Submitted after close, with an entry in the job’s history; a form started after the job closed is refused, and the phone shows why under Needs your attention. Parts recorded on the phone before the job closed are accepted and taken from stock in the same way. A cancelled job takes no parts at all.

A job is invoiced once. If parts recorded on a phone arrive after the job was invoiced, the job’s Invoicing and cost section shows Parts not yet billed; choose Invoice the parts not yet billed to raise a follow-up invoice for them.

To finish something on a completed job, an owner or admin can Reopen it with a reason, and a cancelled job can be reinstated.`,
      keywords: [
        'closed job',
        'completed job',
        'cancelled job',
        'late',
        'submitted after close',
        'offline',
        'sync',
        'refused',
        'parts after close',
        'parts not yet billed',
        'follow-up invoice',
        'reopen',
      ],
    },
    ar: {
      title: 'المهام المغلقة والعمل الذي يرسله الهاتف متأخرًا',
      summary:
        'ما ترفضه المهمة المكتملة أو المعتمدة أو الملغاة، وكيف يُقبل ما سجّله الهاتف من نماذج وقطع قبل إغلاقها، وفوترة القطع التي تصل بعد الفاتورة.',
      body: `المهمة المكتملة أو المعتمدة أو الملغاة مهمة مغلقة. وترفض المهمة المغلقة أي عمل جديد من المكتب: لا يمكن بدء نموذج عليها، ولا إرسال مسودة عليها، ولا تسجيل قطع عليها من شاشات المكتب. ويبقى إرجاع القطع غير المستخدمة مسموحًا.

تعمل الهواتف دون شبكة، فقد ينجز المهندس العمل في وقته ولا يزامن إلا بعد إغلاق المهمة. ويُحكم على عمل الهاتف بوقت إنجازه. فالنموذج الذي بدأه الهاتف قبل إغلاق المهمة يُقبل، ويُعلَّم بأنه «أُرسل بعد الإغلاق» مع قيد في سجل المهمة؛ أما النموذج الذي بدأ بعد إغلاقها فيُرفض، ويعرض الهاتف السبب تحت «يحتاج إلى انتباهك». وتُقبل القطع المسجلة على الهاتف قبل إغلاق المهمة وتُخصم من المخزون بالطريقة نفسها. ولا تقبل المهمة الملغاة أي قطع على الإطلاق.

تُفوتَر المهمة مرة واحدة. فإذا وصلت قطع مسجلة على هاتف بعد فوترة المهمة، يعرض قسم «الفوترة والتكلفة» في المهمة «قطع لم تُفوتَر بعد»؛ فاختر «فوترة القطع التي لم تُفوتَر» لإصدار فاتورة لاحقة لها.

ولإنهاء أمر ما في مهمة مكتملة، يستطيع المالك أو المسؤول إعادة فتحها مع ذكر سبب، ويمكن إعادة المهمة الملغاة.`,
      keywords: [
        'مهمة مغلقة',
        'مهمة مكتملة',
        'مهمة ملغاة',
        'متأخر',
        'أُرسل بعد الإغلاق',
        'دون اتصال',
        'مزامنة',
        'مرفوض',
        'قطع بعد الإغلاق',
        'قطع لم تُفوتَر',
        'فاتورة لاحقة',
        'إعادة فتح',
      ],
    },
  },
  {
    key: 'finance_corrections_rounding',
    module: 'finance',
    feature: 'finance',
    minPermission: 'finance.read',
    appRoute: 'payments',
    public: {
      category: 'sales-finance',
      question: {
        en: 'How do I correct a payment or an invoice, and how are amounts rounded?',
        ar: 'كيف أصحح دفعة أو فاتورة، وكيف تُقرَّب المبالغ؟',
      },
    },
    en: {
      title: 'Correcting money: reversals, follow-up invoices and rounding',
      summary:
        'Reversing a payment that should not stand, moving a payment to the right invoice, billing parts that arrived after the invoice, and how amounts are rounded to piastres.',
      body: `Money is corrected by adding records, never by editing or deleting what was issued, so the history always shows what happened. An issued invoice is corrected with a credit note (Credit), or voided when nothing has been paid or credited against it. A payment put against the wrong invoice is moved with Take back, which returns the money to the customer’s account so it can be put against the right one.

A payment that should not stand, such as a bounced cheque or a payment recorded for the wrong customer, is reversed: on the payment’s page choose Reverse payment and say why. The payment stays on record, marked Reversed, with who reversed it, when and why. Every invoice it paid owes that amount again, it can no longer be put against an invoice, and with the ledger set up the ledger takes the money back on the day of the reversal. A reversal cannot be undone; if the payment was right after all, record it again. Reversing is for owners and admins.

Parts recorded on a phone after a job was invoiced are billed with a follow-up invoice: on the job, Invoicing and cost shows Parts not yet billed, and Invoice the parts not yet billed drafts it.

Amounts are rounded to the currency’s smallest unit, piastres for the Egyptian pound. Each line’s gross, discount, net and tax is rounded half up, and a document’s total is the sum of its rounded lines, so an invoice can be paid exactly by a bank transfer or in cash. Documents issued before this rule keep their four decimal places, and a credit note follows its invoice, so crediting an old invoice in full still matches it exactly.`,
      keywords: [
        'reverse payment',
        'reversal',
        'bounced cheque',
        'wrong customer',
        'take back',
        'credit note',
        'void',
        'correction',
        'follow-up invoice',
        'parts not yet billed',
        'rounding',
        'piastres',
        'decimal places',
      ],
    },
    ar: {
      title: 'تصحيح المبالغ: العكس والفواتير اللاحقة والتقريب',
      summary:
        'عكس دفعة لا يجب أن تبقى، ونقل دفعة إلى الفاتورة الصحيحة، وفوترة قطع وصلت بعد الفاتورة، وكيف تُقرَّب المبالغ إلى القروش.',
      body: `تُصحَّح المبالغ بإضافة سجلات، لا بتعديل ما صدر أو حذفه، حتى يبقى السجل يُظهر ما حدث. فالفاتورة الصادرة تُصحَّح بإشعار دائن («إشعار دائن»)، أو تُلغى إذا لم يُدفع شيء ولم يصدر إشعار دائن مقابلها. والدفعة المخصصة لفاتورة خاطئة تُنقل بـ«استرجاع التخصيص» الذي يعيد المبلغ إلى حساب العميل ليُخصَّص للفاتورة الصحيحة.

أما الدفعة التي لا يجب أن تبقى، مثل شيك مرتجع أو دفعة سُجلت لعميل خاطئ، فتُعكس: في صفحة الدفعة اختر «عكس الدفعة» واذكر السبب. تبقى الدفعة مسجلة بعلامة «معكوسة»، مع من عكسها ومتى ولماذا. وتعود كل فاتورة سددتها مدينة بذلك المبلغ، ولا يمكن تخصيصها لفاتورة بعد ذلك، وعند إعداد الدفتر يسترد الدفتر المبلغ بتاريخ العكس. ولا يمكن التراجع عن العكس؛ فإن تبيّن أن الدفعة كانت صحيحة فسجّلها مجددًا. والعكس للمالكين والمسؤولين.

والقطع المسجلة على هاتف بعد فوترة المهمة تُفوتَر بفاتورة لاحقة: في المهمة يعرض قسم «الفوترة والتكلفة» «قطع لم تُفوتَر بعد»، وينشئ «فوترة القطع التي لم تُفوتَر» مسودتها.

وتُقرَّب المبالغ إلى أصغر وحدة في العملة، أي القرش للجنيه المصري. فيُقرَّب إجمالي كل بند وخصمه وصافيه وضريبته إلى الأقرب مع جبر النصف لأعلى، ويكون إجمالي المستند مجموع بنوده المقرّبة، فيمكن سداد الفاتورة بالضبط بتحويل بنكي أو نقدًا. وتحتفظ المستندات الصادرة قبل هذه القاعدة بأربع خانات عشرية، ويتبع الإشعار الدائن فاتورته، فيبقى إشعار دائن كامل لفاتورة قديمة مطابقًا لها تمامًا.`,
      keywords: [
        'عكس الدفعة',
        'عكس',
        'شيك مرتجع',
        'عميل خاطئ',
        'استرجاع التخصيص',
        'إشعار دائن',
        'إلغاء',
        'تصحيح',
        'فاتورة لاحقة',
        'قطع لم تُفوتَر',
        'التقريب',
        'القروش',
        'خانات عشرية',
      ],
    },
  },
  {
    key: 'app_updates_download',
    module: 'overview',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'getting-started',
      question: {
        en: 'How do I install or update the desktop and phone apps?',
        ar: 'كيف أثبّت تطبيقات سطح المكتب والهاتف أو أحدّثها؟',
      },
    },
    en: {
      title: 'Installing and updating the apps',
      summary:
        'Where to download the desktop and phone apps, how the desktop apps update themselves, and what to do when an app says it is too old.',
      body: `The web app is always the current version: reload the page after an update. The desktop and phone apps are installed, so they have to be updated.

The desktop apps, both the Integr8 staff app and your company’s own, update themselves when Integr8 publishes a new release. Nothing you have saved is lost by updating.

Every installer is on the download page of the web app, at /download, for example app.integr8-media.com/download. With your company’s short name added, as in /download?company=your-company, the page lists your company’s latest desktop installers and its phone app. Integr8 gives you the exact link.

When a desktop or phone app is too old for the server, it says so instead of failing, and Update opens that download page with your company already filled in. Install the new version over the app you have: do not uninstall the phone app first, because uninstalling it removes any work on the phone that has not been sent yet.`,
      keywords: [
        'update',
        'download',
        'install',
        'installer',
        'new version',
        'too old',
        'desktop app',
        'phone app',
        'upgrade',
        'release',
        'download page',
      ],
    },
    ar: {
      title: 'تثبيت التطبيقات وتحديثها',
      summary:
        'من أين تنزّل تطبيقات سطح المكتب والهاتف، وكيف تحدّث تطبيقات سطح المكتب نفسها، وماذا تفعل عندما يقول التطبيق إنه قديم.',
      body: `تطبيق الويب هو دائمًا النسخة الحالية: أعد تحميل الصفحة بعد التحديث. أما تطبيقات سطح المكتب والهاتف فهي مثبّتة، ولذلك تحتاج إلى تحديث.

تحدّث تطبيقات سطح المكتب نفسها، تطبيق موظفي Integr8 وتطبيق شركتك الخاص، عندما تنشر Integr8 إصدارًا جديدًا. ولا يضيع شيء مما حفظته بسبب التحديث.

وكل برامج التثبيت موجودة في صفحة التنزيل في تطبيق الويب، على /download، مثل app.integr8-media.com/download. ومع إضافة الاسم المختصر لشركتك، كما في /download?company=your-company، تعرض الصفحة أحدث برامج تثبيت سطح المكتب الخاصة بشركتك وتطبيق الهاتف. وتعطيك Integr8 الرابط الدقيق.

وعندما يصبح تطبيق سطح المكتب أو الهاتف أقدم مما يقبله الخادم، يخبرك بذلك بدل أن يتعطل، ويفتح «تحديث» صفحة التنزيل تلك مع اسم شركتك معبّأً. ثبّت النسخة الجديدة فوق التطبيق الموجود: لا تحذف تطبيق الهاتف أولًا، لأن حذفه يزيل أي عمل على الهاتف لم يُرسل بعد.`,
      keywords: [
        'تحديث',
        'تنزيل',
        'تثبيت',
        'برنامج التثبيت',
        'نسخة جديدة',
        'قديم',
        'تطبيق سطح المكتب',
        'تطبيق الهاتف',
        'ترقية',
        'إصدار',
        'صفحة التنزيل',
      ],
    },
  },
  {
    key: 'company_website_access',
    module: 'website',
    feature: null,
    covers: ['website_files', 'website_jobs', 'website_quotes', 'website_invoices'],
    minPermission: 'website.access.manage',
    appRoute: 'websiteAccess',
    public: {
      category: 'forms-documents',
      question: {
        en: 'Can our own website show customers their documents, jobs, quotes and invoices?',
        ar: 'هل يستطيع موقعنا الإلكتروني أن يعرض للعملاء مستنداتهم ومهامهم وعروض أسعارهم وفواتيرهم؟',
      },
    },
    en: {
      title: 'Your company website: documents, jobs, quotes and invoices',
      summary:
        'How your own website can show customers their documents, job status, quotes and invoices, the switches on both sides, and website keys.',
      body: `Your company’s own website can show your customers their documents, the status of their jobs, their quotes and their invoices, by asking Integr8 Plus from the website’s server with a website key. The website signs its own customers in; Integr8 Plus answers only for your company.

Each of the four is switched separately, on both sides: Integr8 grants it for your company, and an owner or admin turns it on under Website access, under Company. Both must be on for the website to see it, and all four start off. A company that already had one on keeps it.

Documents are found by a reference such as a certificate number and, when the document’s template asks for it, a second field that must match too, such as the customer. Only shared documents can be found; a document marked Not shared, or with its link stopped, is not found.

Website keys are created by Integr8 and shown once, to be kept in the website server’s settings and never in its pages. Ask Integr8 for a key and for the developer guide.`,
      keywords: [
        'website',
        'company website',
        'website access',
        'website key',
        'customer portal',
        'lookup',
        'certificate lookup',
        'job status',
        'quotes',
        'invoices',
        'documents',
        'api',
      ],
    },
    ar: {
      title: 'موقع شركتك الإلكتروني: المستندات والمهام وعروض الأسعار والفواتير',
      summary:
        'كيف يعرض موقعك الإلكتروني للعملاء مستنداتهم وحالة مهامهم وعروض أسعارهم وفواتيرهم، والمفاتيح على الجانبين، ومفاتيح الموقع.',
      body: `يستطيع موقع شركتك الإلكتروني أن يعرض لعملائك مستنداتهم وحالة مهامهم وعروض أسعارهم وفواتيرهم، بسؤال Integr8 Plus من خادم الموقع بمفتاح موقع. ويسجّل الموقع دخول عملائه بنفسه؛ ولا يجيب Integr8 Plus إلا عن شركتك.

وتُفعَّل كل واحدة من الأربع على حدة، وعلى الجانبين: تمنحها Integr8 لشركتك، ويفعّلها المالك أو المسؤول من «وصول الموقع» تحت مجموعة الشركة. ويجب أن يكون الجانبان مفعّلين ليراها الموقع، وتبدأ الأربع متوقفة. والشركة التي كانت قد فعّلت إحداها تحتفظ بها.

ويُعثر على المستندات برقم مرجعي مثل رقم الشهادة، وبحقل ثانٍ يجب أن يطابق أيضًا، مثل العميل، عندما يطلبه قالب المستند. ولا يُعثر إلا على المستندات المُشارَكة؛ أما المستند غير المُشارَك أو الذي أُوقف رابطه فلا يُعثر عليه.

وتنشئ Integr8 مفاتيح الموقع وتعرضها مرة واحدة، لتُحفظ في إعدادات خادم الموقع لا في صفحاته أبدًا. اطلب من Integr8 مفتاحًا ودليل المطوّر.`,
      keywords: [
        'الموقع الإلكتروني',
        'موقع الشركة',
        'وصول الموقع',
        'مفتاح الموقع',
        'بوابة العملاء',
        'بحث',
        'البحث عن شهادة',
        'حالة المهمة',
        'عروض الأسعار',
        'الفواتير',
        'المستندات',
        'واجهة برمجية',
      ],
    },
  },
  {
    key: 'data_export_closing',
    module: 'account',
    feature: null,
    minPermission: null,
    appRoute: null,
    public: {
      category: 'account-billing',
      question: {
        en: 'Can I get all my data out, and what happens if we leave?',
        ar: 'هل أستطيع الحصول على كل بياناتي، وماذا يحدث إذا غادرنا؟',
      },
    },
    en: {
      title: 'Your data: export, retention and closing the account',
      summary:
        'Getting a copy of everything the company holds, how long records and files are kept, and what happens when a company account is closed.',
      body: `Your company’s data is yours. Ask Integr8 and they export everything the company holds for you, whenever you ask, including while the account is read-only or suspended.

Nothing is deleted on a schedule unless a retention window has been agreed with your company first. Integr8 sets one only after telling you, and the company logo and app icon are never removed by it.

Closing an account is done by Integr8: the company is suspended, its data is exported for you, and the account is closed. Seven days after closing, everything is deleted for good, including the sign-in accounts of your people that belong to no other company.`,
      keywords: [
        'export',
        'my data',
        'download everything',
        'backup',
        'retention',
        'delete',
        'close account',
        'cancel',
        'leave',
        'suspend',
        'purge',
      ],
    },
    ar: {
      title: 'بياناتك: التصدير والاحتفاظ وإغلاق الحساب',
      summary:
        'الحصول على نسخة من كل ما تحتفظ به الشركة، ومدة الاحتفاظ بالسجلات والملفات، وما يحدث عند إغلاق حساب الشركة.',
      body: `بيانات شركتك ملك لك. اطلب من Integr8 فتصدّر لك كل ما تحتفظ به الشركة، متى طلبت، حتى عندما يكون الحساب للقراءة فقط أو موقوفًا.

لا يُحذف شيء وفق جدول زمني ما لم يُتفق مع شركتك أولًا على مدة احتفاظ. ولا تحددها Integr8 إلا بعد إخبارك، ولا تُزال بها أبدًا شعار الشركة وأيقونة التطبيق.

وتغلق Integr8 الحساب: تُوقف الشركة، وتُصدَّر بياناتها لك، ثم يُغلق الحساب. وبعد سبعة أيام من الإغلاق يُحذف كل شيء نهائيًا، بما في ذلك حسابات تسجيل الدخول لأشخاصك التي لا تنتمي إلى أي شركة أخرى.`,
      keywords: [
        'تصدير',
        'بياناتي',
        'تنزيل كل شيء',
        'نسخة احتياطية',
        'الاحتفاظ',
        'حذف',
        'إغلاق الحساب',
        'إلغاء',
        'مغادرة',
        'إيقاف',
        'الحذف النهائي',
      ],
    },
  },
];
