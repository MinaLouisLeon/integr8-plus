import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Editing pipelines and stages over HTTP (eighth round; ADR-0012): owners and
 * admins only; keys stay; an archived stage's open opportunities move, with
 * their history; a pipeline keeps an open, a won and a lost stage; the
 * default is never archived.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let dispatcher: Member;
const tokens = new Map<Member, string>();

interface Stage {
  id: string;
  key: string;
  label: string;
  position: number;
  outcome: string;
  archived: boolean;
  openCount: number;
}
interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
  can: { edit: boolean };
}

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('pipe-edit-staff');
  owner = await api.member('owner', 'pipe-edit-owner');
  admin = await api.member('admin', 'pipe-edit-admin');
  dispatcher = await api.member('dispatcher', 'pipe-edit-dispatcher');
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/crm`,
    payload: { enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
});

afterAll(async () => {
  await api.close();
});

describe('pipelines', () => {
  let service: Pipeline;

  it('are added and renamed by owners and admins, not dispatchers', async () => {
    expect(
      (await call(dispatcher, 'POST', '/v1/crm/pipelines', { name: 'Service' })).statusCode,
    ).toBe(403);
    const created = await call(admin, 'POST', '/v1/crm/pipelines', { name: 'Service' });
    expect(created.statusCode, created.body).toBe(201);
    service = json<Pipeline>(created);
    expect(service.stages.map((stage) => stage.key)).toEqual([
      'new',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    expect(code(await call(owner, 'POST', '/v1/crm/pipelines', { name: 'service' }))).toBe(
      'name_taken',
    );
    const renamed = await call(owner, 'PATCH', `/v1/crm/pipelines/${service.id}`, {
      name: 'Maintenance',
    });
    expect(json<Pipeline>(renamed).name).toBe('Maintenance');
    // Dispatchers read pipelines and keep using them.
    expect(
      json<Pipeline>(await call(dispatcher, 'GET', `/v1/crm/pipelines/${service.id}`)).can,
    ).toEqual({ edit: false });
  });

  it('gain, reorder and rename stages, keeping their keys', async () => {
    const added = json<Pipeline>(
      await call(admin, 'POST', `/v1/crm/pipelines/${service.id}/stages`, {
        label: 'Site survey',
        probabilityBp: 3500,
      }),
    );
    const survey = added.stages.find((stage) => stage.label === 'Site survey')!;
    expect(survey).toMatchObject({ key: 'site_survey', outcome: 'open' });
    const current = added.stages.filter((stage) => !stage.archived).map((stage) => stage.id);
    const order = [current[0]!, survey.id, ...current.slice(1).filter((id) => id !== survey.id)];
    const reordered = json<Pipeline>(
      await call(owner, 'PUT', `/v1/crm/pipelines/${service.id}/stages/order`, {
        stageIds: order,
      }),
    );
    expect(reordered.stages.slice(0, 2).map((stage) => stage.key)).toEqual(['new', 'site_survey']);
    expect(
      code(
        await call(owner, 'PUT', `/v1/crm/pipelines/${service.id}/stages/order`, {
          stageIds: order.slice(1),
        }),
      ),
    ).toBe('order_incomplete');
    const relabelled = json<Pipeline>(
      await call(owner, 'PATCH', `/v1/crm/pipelines/${service.id}/stages/${survey.id}`, {
        label: 'Survey on site',
      }),
    );
    expect(relabelled.stages.find((stage) => stage.id === survey.id)).toMatchObject({
      key: 'site_survey',
      label: 'Survey on site',
    });
    // The last won stage stays won.
    const won = relabelled.stages.find((stage) => stage.key === 'won')!;
    expect(
      code(
        await call(owner, 'PATCH', `/v1/crm/pipelines/${service.id}/stages/${won.id}`, {
          outcome: 'open',
        }),
      ),
    ).toBe('stage_needed');
  });

  it('archive a stage by moving its open opportunities, with their history', async () => {
    const customer = await call(owner, 'POST', '/v1/customers', { name: 'Delta Towers' });
    const customerId = json<{ id: string }>(customer).id;
    const detail = json<Pipeline>(await call(owner, 'GET', `/v1/crm/pipelines/${service.id}`));
    const qualified = detail.stages.find((stage) => stage.key === 'qualified')!;
    const proposal = detail.stages.find((stage) => stage.key === 'proposal')!;
    const lost = detail.stages.find((stage) => stage.key === 'lost')!;
    const created = await call(owner, 'POST', '/v1/crm/opportunities', {
      title: 'Lift contract',
      customerId,
      stageId: detail.stages.find((stage) => stage.key === 'new')!.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const opportunity = json<{ id: string; version: number }>(created);
    const moved = await call(owner, 'POST', `/v1/crm/opportunities/${opportunity.id}/transitions`, {
      expectedVersion: opportunity.version,
      stageId: qualified.id,
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const archive = (body: Record<string, unknown>) =>
      call(owner, 'POST', `/v1/crm/pipelines/${service.id}/stages/${qualified.id}/archive`, body);
    expect(code(await archive({}))).toBe('move_required');
    expect(code(await archive({ moveToStageId: lost.id }))).toBe('move_target_not_open');
    const archived = await archive({ moveToStageId: proposal.id });
    expect(archived.statusCode, archived.body).toBe(200);
    const result = json<{ pipeline: Pipeline; moved: number }>(archived);
    expect(result.moved).toBe(1);
    expect(result.pipeline.stages.find((stage) => stage.id === qualified.id)?.archived).toBe(true);
    expect(result.pipeline.stages.find((stage) => stage.id === proposal.id)?.openCount).toBe(1);
    const history = json<{ events: { kind: string }[] }>(
      await call(owner, 'GET', `/v1/crm/opportunities/${opportunity.id}`),
    );
    expect(history.events.filter((event) => event.kind === 'stage_changed')).toHaveLength(2);

    // Not while it holds open opportunities; never the default.
    expect(code(await call(owner, 'DELETE', `/v1/crm/pipelines/${service.id}`))).toBe(
      'pipeline_has_open',
    );
    const pipelines = json<{ items: Pipeline[] }>(await call(owner, 'GET', '/v1/crm/pipelines'));
    const standard = pipelines.items.find((pipeline) => pipeline.isDefault)!;
    expect(code(await call(owner, 'DELETE', `/v1/crm/pipelines/${standard.id}`))).toBe(
      'default_pipeline',
    );
  });
});
