import { randomUUID } from 'node:crypto';
import {
  type DeadlineRule,
  type PlatformUserId,
  ROLES,
  type Role,
  toTenantId,
  toUserId,
} from '@integr8/core';
import {
  getPlatformDataSource,
  type Tenant,
  type TenantSettings,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import type { TemplateDesign } from '@integr8/document-render';
import {
  assertPicturesFit,
  bringTemplatesIn,
  companyPictures,
  companyStore,
  copyPictures,
  discardPictures,
  type IncomingTemplate,
  type PictureCopy,
  type PictureSource,
} from '../documents/template-copies.js';
import { conflict, notFound } from '../http/errors.js';
import { categoryOf, mediaKey, type MediaStorage } from '../media/storage.js';
import { onboardCompany } from './onboarding.js';

/**
 * A test twin of a real company (P44, option A): a new test company with the
 * real one's setup and none of its business.
 *
 * The developer MCP server may only reach test companies (P38), and that is
 * deliberate: everything an AI tool reads goes to its model provider, and a
 * real company's customers, people, money and HR records must not. So, to help
 * build a real company, staff make its twin from the staff app and the AI
 * tool works there; what it builds goes back through the staff app's own
 * copy steps (a form is copied to the real company as an unpublished draft),
 * by a person, in a full staff session.
 *
 * What a twin carries is the company's **setup**, which Integr8 staff made
 * for it in the first place: its settings and branding (logo and app icon
 * copied), modules and tabs, company roles, qualification types, job types
 * with their forms and required qualifications, deadline rules, expense
 * categories, and every form that is not archived (its last published version
 * published again, its draft kept as a draft) with its PDF templates and their
 * pictures.
 *
 * What it never carries: people (it gets made-up ones, below), customers,
 * sites, jobs, submissions, documents, stock, money, the ledger, HR and
 * payroll, contracts, website keys, its website address and document link
 * pattern, e-invoicing settings and sign-in accounts. Its own apps are off and
 * never built (it is a test company), and the assistant is off.
 *
 * The made-up people: one active member per built-in role, with addresses
 * under `example.com` and no sign-in account, so the developer MCP server can
 * act as each role (it acts through impersonation grants and needs nobody to
 * sign in). A test company's mail goes to its outbox, never out.
 */

/** Addresses no mail server will ever accept (RFC 2606). */
export function twinEmail(role: Role, slug: string): string {
  return `${role.replaceAll('_', '.')}@${slug}.test-twin.example.com`;
}

const ROLE_NAMES: Record<Role, string> = {
  owner: 'Twin Owner',
  admin: 'Twin Admin',
  hr_manager: 'Twin HR Manager',
  inventory_manager: 'Twin Inventory Manager',
  accountant: 'Twin Accountant',
  dispatcher: 'Twin Dispatcher',
  engineer: 'Twin Engineer',
  viewer: 'Twin Viewer',
};

/** The longest slug a company may have. */
const SLUG_MAX = 63;

/**
 * The first free slug for a twin: `<source>-twin`, then `-twin-2`, … The
 * source part is cut so the whole fits.
 */
export async function freeTwinSlug(
  sourceSlug: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? '-twin' : `-twin-${String(n)}`;
    const base = sourceSlug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/u, '');
    const slug = `${base}${suffix}`;
    if (!(await taken(slug))) {
      return slug;
    }
  }
  throw conflict('slug_taken', 'Too many twins of this company; choose a slug.');
}

/**
 * An `open_form` action names another form of the company by id; in the twin
 * that form has a new id. An action whose form was not copied (archived) is
 * left out rather than pointed at nothing; the count is reported.
 */
export function remapActions(
  actions: readonly unknown[],
  formIds: ReadonlyMap<string, string>,
): { actions: unknown[]; dropped: number } {
  const kept: unknown[] = [];
  let dropped = 0;
  for (const action of actions) {
    if (
      typeof action === 'object' &&
      action !== null &&
      (action as { kind?: unknown }).kind === 'open_form'
    ) {
      const target = formIds.get(String((action as { form?: unknown }).form));
      if (target === undefined) {
        dropped += 1;
        continue;
      }
      kept.push({ ...action, form: target });
      continue;
    }
    kept.push(action);
  }
  return { actions: kept, dropped };
}

// ---------------------------------------------------------------------------
// Reading the source's setup
// ---------------------------------------------------------------------------

interface SourceForm {
  id: string;
  title: string;
  fillRoles: Role[];
  signatureRequired: boolean;
  published: { definition: Record<string, unknown>; actions: unknown[] } | null;
  draft: { definition: Record<string, unknown>; actions: unknown[] } | null;
  templates: IncomingTemplate[];
  pictures: PictureSource[];
}

interface SourceSetup {
  settings: TenantSettings;
  /** The logo and app icon as stored, when the company has them. */
  brandPictures: PictureSource[];
  flags: Record<string, boolean>;
  roles: Awaited<ReturnType<TenantTransaction['tenantRoles']['list']>>;
  qualificationTypes: Awaited<ReturnType<TenantTransaction['qualifications']['listTypes']>>;
  jobTypes: Awaited<ReturnType<TenantTransaction['jobTypes']['list']>>;
  jobTypeQualifications: Map<string, string[]>;
  deadlineRules: DeadlineRule[];
  expenseCategories: string[];
  forms: SourceForm[];
}

async function readSetup(tenantId: string): Promise<SourceSetup> {
  const flags = await getPlatformDataSource().settings.flagsFor(tenantId);
  return withTenant(toTenantId(tenantId), async (tx) => {
    const settings = await tx.settings.get();
    const brandIds = [settings.logoMediaId, settings.appIconMediaId].filter(
      (id): id is string => id !== null,
    );
    const brandPictures = (await tx.files.findMany(brandIds))
      .filter((file) => file.deletedAt === null && file.purgedAt === null)
      .map((file) => ({
        id: file.id,
        storageKey: file.storageKey,
        contentType: file.contentType,
        byteSize: file.byteSize,
      }));

    const jobTypes = await tx.jobTypes.list();
    const forms: SourceForm[] = [];
    for (const form of await tx.forms.listForms()) {
      const published = await tx.forms.findLatestPublished(form.id);
      const draft = await tx.forms.findDraft(form.id);
      if (published === undefined && draft === undefined) {
        continue;
      }
      const templates = await tx.documentTemplates.list({ formId: form.id });
      const designs = templates.map((template) => template.design as TemplateDesign);
      forms.push({
        id: form.id,
        title: form.title,
        fillRoles: form.fillRoles,
        signatureRequired: form.signatureRequired,
        published:
          published === undefined
            ? null
            : { definition: published.definition, actions: published.actions },
        draft:
          draft === undefined ? null : { definition: draft.definition, actions: draft.actions },
        templates: templates.map((template, index) => ({
          name: template.name,
          design: designs[index]!,
        })),
        pictures: await companyPictures(tx, designs),
      });
    }

    return {
      settings,
      brandPictures,
      flags,
      roles: await tx.tenantRoles.list(),
      qualificationTypes: await tx.qualifications.listTypes(),
      jobTypes,
      jobTypeQualifications: await tx.qualifications.jobTypeRequirements(
        jobTypes.map((type) => type.id),
      ),
      deadlineRules: (await tx.deadlines.listRules()).map((rule) => ({
        priority: rule.priority,
        responseMinutes: rule.responseMinutes,
        completionMinutes: rule.completionMinutes,
        clock: rule.clock,
        warnMinutes: rule.warnMinutes,
      })),
      expenseCategories: (await tx.hrExpenses.categories()).map((category) => category.name),
      forms,
    };
  });
}

// ---------------------------------------------------------------------------
// Making the twin
// ---------------------------------------------------------------------------

export interface MakeTestTwinInput {
  sourceTenantId: string;
  /** Defaults to `<source name> (test twin)`. */
  name?: string;
  /** Defaults to the first free `<source slug>-twin`. */
  slug?: string;
  /** The super admin making it. */
  by: PlatformUserId;
  media: MediaStorage;
}

export interface TestTwinCounts {
  people: number;
  roles: number;
  qualificationTypes: number;
  jobTypes: number;
  deadlineRules: number;
  expenseCategories: number;
  forms: number;
  publishedForms: number;
  documentTemplates: number;
  pictures: number;
  modules: number;
  /** `open_form` actions left out because their form was not copied. */
  droppedActions: number;
}

export interface MadeTestTwin {
  source: Tenant;
  twin: Tenant;
  people: { role: Role; email: string; userId: string }[];
  counts: TestTwinCounts;
  /** Set when storage could not be prepared and pictures were left out. */
  storageProblem: string | null;
}

export async function makeTestTwin(input: MakeTestTwinInput): Promise<MadeTestTwin> {
  const platform = getPlatformDataSource();
  const source = await platform.tenants.findById(input.sourceTenantId);
  if (source?.deletedAt !== null) {
    throw notFound('This company does not exist.');
  }
  if (source.status === 'cancelled') {
    throw conflict('company_closed', 'This company is closed; it has nothing to copy.');
  }

  const slug =
    input.slug ??
    (await freeTwinSlug(
      source.slug,
      async (candidate) => (await platform.tenants.findBySlug(candidate)) !== undefined,
    ));
  if (input.slug !== undefined && (await platform.tenants.findBySlug(input.slug)) !== undefined) {
    throw conflict('slug_taken', `A company already uses the slug "${input.slug}"`);
  }

  // Everything is read before anything is made: a source that cannot be read
  // (a picture gone from storage) leaves no half-made twin behind.
  const setup = await readSetup(source.id);
  const allPictures = [...setup.brandPictures, ...setup.forms.flatMap((form) => form.pictures)];

  const people = ROLES.map((role) => ({
    role,
    email: twinEmail(role, slug),
    userId: randomUUID(),
  }));
  const owner = people.find((person) => person.role === 'owner')!;

  const onboarded = await onboardCompany({
    slug,
    name: input.name ?? `${source.name} (test twin)`.slice(0, 200),
    plan: source.plan,
    seats: null,
    ownerEmail: owner.email,
    websiteUrl: null,
    aiChannels: { desktop: false, mobile: false },
    isTest: true,
    ownerAccess: { kind: 'direct', userId: owner.userId, displayName: ROLE_NAMES.owner },
    jobTypes: [],
    onboardedBy: input.by,
    invitationTtlSeconds: 60,
    media: input.media,
  });
  const twin = onboarded.tenant;

  // Pictures first: object storage cannot join the transaction below, and on
  // any failure there whatever was written here is removed again.
  let copies: PictureCopy[] = [];
  let storageProblem = onboarded.storage.error;
  let target: Awaited<ReturnType<typeof companyStore>> | null = null;
  if (allPictures.length > 0 && storageProblem === null) {
    try {
      await assertPicturesFit(twin.id, allPictures);
      target = await companyStore(input.media, twin.id);
      copies = await copyPictures(
        await companyStore(input.media, source.id),
        target,
        allPictures,
        mediaKey,
      );
    } catch (error) {
      storageProblem = error instanceof Error ? error.message : String(error);
      copies = [];
    }
  } else if (allPictures.length > 0) {
    storageProblem ??= 'storage not ready';
  }
  const copyOf = new Map(copies.map((copy) => [copy.from, copy]));

  for (const [key, enabled] of Object.entries(setup.flags)) {
    await platform.settings.setFlag({ tenantId: twin.id, key, enabled, updatedBy: input.by });
  }

  const actor = toUserId(input.by);
  try {
    const counts = await withTenant(toTenantId(twin.id), async (tx) => {
      // The other made-up people; the owner was made by onboarding.
      for (const person of people) {
        if (person.role !== 'owner') {
          await tx.tenantUsers.create({
            userId: person.userId,
            email: person.email,
            displayName: ROLE_NAMES[person.role],
            role: person.role,
            status: 'active',
          });
        }
      }

      const s = setup.settings;
      const logo = s.logoMediaId === null ? undefined : copyOf.get(s.logoMediaId);
      const icon = s.appIconMediaId === null ? undefined : copyOf.get(s.appIconMediaId);
      for (const copy of [logo, icon]) {
        if (copy !== undefined) {
          await tx.files.recordGenerated({
            id: copy.id,
            bucket: copy.bucket,
            storageKey: copy.storageKey,
            stored: copy.stored,
            category: categoryOf(copy.contentType),
            uploadedBy: actor,
            linkedEntity: null,
          });
        }
      }
      await tx.settings.update({
        logoMediaId: logo?.id ?? null,
        appIconMediaId: icon?.id ?? null,
        brandColour: s.brandColour,
        shellColour: s.shellColour,
        defaultTheme: s.defaultTheme,
        timezone: s.timezone,
        currency: s.currency,
        locale: s.locale,
        workDayStarts: s.workDayStarts,
        workDayEnds: s.workDayEnds,
        workingDays: s.workingDays,
        websiteFilesEnabled: s.websiteFilesEnabled,
        websiteJobsEnabled: s.websiteJobsEnabled,
        websiteQuotesEnabled: s.websiteQuotesEnabled,
        websiteInvoicesEnabled: s.websiteInvoicesEnabled,
        qualificationWarningDays: s.qualificationWarningDays,
        showCompanyName: s.showCompanyName,
        hiddenNavSections: s.hiddenNavSections,
      });

      for (const role of setup.roles) {
        await tx.tenantRoles.create(
          {
            name: role.name,
            description: role.description,
            baseRole: role.baseRole,
            added: role.added,
            removed: role.removed,
          },
          actor,
        );
      }

      const qualificationIds = new Map<string, string>();
      for (const type of setup.qualificationTypes) {
        const written = await tx.qualifications.createType(
          { name: type.name, kind: type.kind, description: type.description },
          actor,
        );
        if (written.outcome === 'written') {
          qualificationIds.set(type.id, written.type.id);
        }
      }

      // Forms before their versions: an action of one form may open another.
      const formIds = new Map<string, string>();
      for (const form of setup.forms) {
        const created = await tx.forms.createForm({
          title: form.title,
          createdBy: actor,
          fillRoles: form.fillRoles,
          signatureRequired: form.signatureRequired,
        });
        formIds.set(form.id, created.id);
      }

      let publishedForms = 0;
      let documentTemplates = 0;
      let pictures = logo === undefined ? 0 : 1;
      pictures += icon === undefined ? 0 : 1;
      let droppedActions = 0;
      for (const form of setup.forms) {
        const formId = formIds.get(form.id)!;
        if (form.published !== null) {
          const remapped = remapActions(form.published.actions, formIds);
          droppedActions += remapped.dropped;
          const draft = await tx.forms.createDraft({
            formId,
            definition: form.published.definition,
            actions: remapped.actions,
            createdBy: actor,
          });
          await tx.forms.publishDraft(draft.id, actor, {
            changeNote: 'Copied from the real company into its test twin',
          });
          publishedForms += 1;
        }
        if (form.draft !== null) {
          const remapped = remapActions(form.draft.actions, formIds);
          droppedActions += remapped.dropped;
          await tx.forms.createDraft({
            formId,
            definition: form.draft.definition,
            actions: remapped.actions,
            createdBy: actor,
          });
        }
        // A form's PDF templates only when all their pictures arrived: a
        // template with a hole in it would print wrong and say nothing.
        const formCopies = form.pictures.map((picture) => copyOf.get(picture.id));
        if (form.templates.length > 0 && formCopies.every((copy) => copy !== undefined)) {
          const brought = await bringTemplatesIn({
            tx,
            formId,
            templates: form.templates,
            copies: formCopies,
            by: actor,
          });
          documentTemplates += brought.templateIds.length;
          pictures += brought.pictures;
        }
      }

      for (const type of setup.jobTypes) {
        const created = await tx.jobTypes.create(
          {
            name: type.name,
            code: type.code,
            description: type.description,
            expectedDurationMinutes: type.expectedDurationMinutes,
            defaultPriority: type.defaultPriority,
            instructions: type.instructions,
            checklist: type.checklist,
            beforePhotos: type.beforePhotos,
            afterPhotos: type.afterPhotos,
            signatureRequired: type.signatureRequired,
            forms: type.forms
              .filter((link) => formIds.has(link.formId))
              .sort((a, b) => a.position - b.position)
              .map((link) => ({ formId: formIds.get(link.formId)!, required: link.required })),
          },
          actor,
        );
        const required = (setup.jobTypeQualifications.get(type.id) ?? [])
          .map((id) => qualificationIds.get(id))
          .filter((id): id is string => id !== undefined);
        if (required.length > 0) {
          await tx.qualifications.setJobTypeRequirements(created.id, required, actor);
        }
      }

      if (setup.deadlineRules.length > 0) {
        await tx.deadlines.replaceRules(setup.deadlineRules, actor);
      }
      for (const name of setup.expenseCategories) {
        await tx.hrExpenses.createCategory({ name, accountId: null }, actor);
      }

      await tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: input.by,
        actorLabel: 'Test twin',
        action: 'tenant.test_twin_filled',
        resourceType: 'tenant',
        resourceId: twin.id,
        metadata: { sourceTenantId: source.id, sourceSlug: source.slug },
      });

      return {
        people: people.length,
        roles: setup.roles.length,
        qualificationTypes: qualificationIds.size,
        jobTypes: setup.jobTypes.length,
        deadlineRules: setup.deadlineRules.length,
        expenseCategories: setup.expenseCategories.length,
        forms: setup.forms.length,
        publishedForms,
        documentTemplates,
        pictures,
        modules: Object.values(setup.flags).filter(Boolean).length,
        droppedActions,
      };
    });
    return { source, twin, people, counts, storageProblem };
  } catch (error) {
    if (target !== null) {
      await discardPictures(target, copies);
    }
    throw error;
  }
}
