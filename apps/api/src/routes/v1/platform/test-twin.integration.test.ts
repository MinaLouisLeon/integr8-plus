import { randomUUID } from 'node:crypto';
import { toTenantId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * A test twin (P44, option A): a new test company with a real company's setup
 * and none of its business, made by a full staff session only.
 */

let api: ApiHarness;
let full: PlatformAdmin;
let limited: PlatformAdmin;

const STAFF = '00000000-0000-4000-8000-0000000000f1';
const errorCode = (body: string) => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

interface TwinBody {
  source: { id: string };
  twin: { id: string; slug: string; name: string };
  people: { role: string; email: string }[];
  copied: Record<string, number>;
  storageProblem: string | null;
}

let first: string;
let second: string;

beforeAll(async () => {
  api = await startApi();
  full = await api.platformAdmin('full');
  limited = await api.platformAdmin('developer', { scope: 'test_companies' });

  // The source's setup, and some business that must stay behind.
  const definition = FORM_TEMPLATES[0]!.definition as unknown as Record<string, unknown>;
  await getPlatformDataSource().settings.setFlag({
    tenantId: api.tenantId,
    key: 'hr',
    enabled: true,
    updatedBy: null,
  });
  await withTenant(toTenantId(api.tenantId), async (tx) => {
    const a = await tx.forms.createForm({ title: 'Site survey', createdBy: STAFF });
    const b = await tx.forms.createForm({ title: 'Follow-up', createdBy: STAFF });
    first = a.id;
    second = b.id;
    const draftB = await tx.forms.createDraft({ formId: b.id, definition, createdBy: STAFF });
    await tx.forms.publishDraft(draftB.id, STAFF);
    const draftA = await tx.forms.createDraft({
      formId: a.id,
      definition,
      createdBy: STAFF,
      actions: [{ id: 'next', kind: 'open_form', form: b.id, required: true }],
    });
    await tx.forms.publishDraft(draftA.id, STAFF);
    // A draft after the published version stays a draft in the twin.
    await tx.forms.createDraft({ formId: a.id, definition, createdBy: STAFF });

    const skill = await tx.qualifications.createType(
      { name: 'Gas safe', kind: 'certificate', description: null },
      STAFF,
    );
    const jobType = await tx.jobTypes.create(
      { name: 'Boiler service', code: 'BOILER', forms: [{ formId: a.id, required: true }] },
      STAFF,
    );
    if (skill.outcome === 'written') {
      await tx.qualifications.setJobTypeRequirements(jobType.id, [skill.type.id], STAFF);
    }
    await tx.tenantRoles.create(
      { name: 'Senior engineer', description: null, baseRole: 'engineer', added: [], removed: [] },
      STAFF,
    );
    await tx.hrExpenses.createCategory({ name: 'Fuel', accountId: null }, STAFF);
    await tx.settings.update({ brandColour: '#123456', workingDays: [7, 1, 2, 3, 4] });
    await tx.customers.create({ name: 'A real customer' }, STAFF);
  });
});

afterAll(async () => {
  await api.close();
});

describe('making a test twin', () => {
  it('is refused to a session limited to test companies', async () => {
    const refused = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/test-twin`,
      payload: { reason: 'Developer MCP trying to read a real company' },
    });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.body)).toBe('session_scope');
  });

  it('needs a reason', async () => {
    const refused = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/test-twin`,
      payload: {},
    });
    // A body that fails its schema is a validation error (422), as everywhere.
    expect(refused.statusCode).toBe(422);
  });

  it('copies the setup and none of the business', async () => {
    const response = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/test-twin`,
      payload: { reason: 'Building the new inspection forms' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as TwinBody;
    expect(body.twin.slug.endsWith('-twin')).toBe(true);
    expect(body.copied).toMatchObject({
      forms: 2,
      publishedForms: 2,
      jobTypes: 1,
      qualificationTypes: 1,
      roles: 1,
      expenseCategories: 1,
      people: 8,
      droppedActions: 0,
    });
    expect(body.people.every((person) => person.email.endsWith('.test-twin.example.com'))).toBe(
      true,
    );

    const twin = await getPlatformDataSource().tenants.findById(body.twin.id);
    expect(twin?.isTest).toBe(true);
    expect((await getPlatformDataSource().settings.flagsFor(body.twin.id)).hr).toBe(true);

    await withTenant(toTenantId(body.twin.id), async (tx) => {
      expect((await tx.customers.list()).items).toEqual([]);
      const members = await tx.tenantUsers.list();
      expect(members).toHaveLength(8);
      expect(members.every((member) => member.status === 'active')).toBe(true);

      const settings = await tx.settings.get();
      expect(settings.brandColour).toBe('#123456');
      expect(settings.workingDays).toEqual([7, 1, 2, 3, 4]);
      expect(settings.websiteUrl).toBeNull();

      const forms = await tx.forms.listForms();
      const survey = forms.find((form) => form.title === 'Site survey')!;
      const followUp = forms.find((form) => form.title === 'Follow-up')!;
      expect([survey.id, followUp.id]).not.toContain(first);
      expect([survey.id, followUp.id]).not.toContain(second);
      const published = await tx.forms.findLatestPublished(survey.id);
      expect(published?.actions).toEqual([
        { id: 'next', kind: 'open_form', form: followUp.id, required: true },
      ]);
      expect(await tx.forms.findDraft(survey.id)).toBeDefined();
      expect(await tx.forms.findDraft(followUp.id)).toBeUndefined();

      const [jobType] = await tx.jobTypes.list();
      expect(jobType?.code).toBe('BOILER');
      expect(jobType?.forms.map((link) => link.formId)).toEqual([survey.id]);
      const required = await tx.qualifications.jobTypeRequirements([jobType!.id]);
      expect(required.get(jobType!.id)).toHaveLength(1);
      expect((await tx.tenantRoles.list()).map((role) => role.name)).toEqual(['Senior engineer']);
      expect((await tx.hrExpenses.categories()).map((category) => category.name)).toEqual(['Fuel']);
    });

    // The real company's own log says a twin was made of it.
    const lines = await withTenant(toTenantId(api.tenantId), (tx) =>
      tx.auditLog.list({ limit: 20 }),
    );
    const line = lines.find((entry) => entry.action === 'tenant.test_twin_made');
    expect(line?.metadata).toMatchObject({
      twinTenantId: body.twin.id,
      reason: 'Building the new inspection forms',
    });
  });

  it('takes the next free slug for a second twin, and refuses a taken one', async () => {
    const again = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/test-twin`,
      payload: { reason: 'A second try' },
    });
    expect(again.statusCode).toBe(201);
    const body = JSON.parse(again.body) as TwinBody;
    expect(body.twin.slug.endsWith('-twin-2')).toBe(true);

    const taken = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/test-twin`,
      payload: { reason: 'A taken slug', slug: body.twin.slug },
    });
    expect(taken.statusCode).toBe(409);
    expect(errorCode(taken.body)).toBe('slug_taken');
  });

  it('answers 404 for a company that does not exist', async () => {
    const missing = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${randomUUID()}/test-twin`,
      payload: { reason: 'Nobody' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
