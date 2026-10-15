import { type Principal, toTenantId, toUserId } from '@integr8/core';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../config.js';
import { INSIGHT_TOOLS } from './insights.js';
import { gateOf, toolsFor, toProviderDefinition } from './registry.js';

/**
 * Which tools a member is offered (docs/ai §8.1): the level, the seat's
 * permission, the company's module and the provider's data-class approval all
 * have to agree, and the registry says which one did not.
 */

function principal(role: Principal['role']): Principal {
  return {
    userId: toUserId('00000000-0000-4000-8000-0000000000a1'),
    tenantId: toTenantId('00000000-0000-4000-8000-0000000000t1'.replace('t', '0')),
    role,
    grants: [],
    sessionId: 's',
    tokenId: 't',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const approved = loadApiConfig({
  APP_ENV: 'test',
  AI_PROVIDER: 'recording',
});
const live = loadApiConfig({
  APP_ENV: 'test',
  AI_PROVIDER: 'groq',
  AI_GROQ_API_KEY: 'k',
  AI_MODEL_HELP: 'm',
  AI_PROVIDER_APPROVED_DATA_CLASSES: 'groq:company_operational',
});

const everything = { crm: true, finance: true, inventory: true, assets: true, hr: true };

describe('the gates', () => {
  it('offers nothing at the help level', () => {
    expect(
      toolsFor(INSIGHT_TOOLS, {
        level: 'help',
        principal: principal('owner'),
        features: everything,
        companyDataToProvider: true,
        config: approved,
      }),
    ).toEqual([]);
  });

  it('offers an owner everything at insights with the fake provider and the company’s consent', () => {
    const offered = toolsFor(INSIGHT_TOOLS, {
      level: 'insights',
      principal: principal('owner'),
      features: everything,
      companyDataToProvider: true,
      config: approved,
    });
    expect(offered.map((tool) => tool.key)).toEqual(INSIGHT_TOOLS.map((tool) => tool.key));
  });

  it('offers nothing of the company’s data without the company’s consent', () => {
    const offered = toolsFor(INSIGHT_TOOLS, {
      level: 'agent',
      principal: principal('owner'),
      features: everything,
      companyDataToProvider: false,
      config: approved,
    });
    expect(offered).toEqual([]);
  });

  it('keeps financial data from a provider approved only for operational data', () => {
    const offered = toolsFor(INSIGHT_TOOLS, {
      level: 'insights',
      principal: principal('owner'),
      features: everything,
      companyDataToProvider: true,
      config: live,
    });
    expect(offered.map((tool) => tool.key)).not.toContain('get_invoice_summary');
    expect(offered.map((tool) => tool.key)).toContain('get_work_order_summary');
  });

  it('withholds a module the company lacks and a permission the seat lacks, and says which', () => {
    const noCrm = { ...everything, crm: false };
    const pipeline = INSIGHT_TOOLS.find((tool) => tool.key === 'get_crm_pipeline_summary')!;
    expect(
      gateOf(pipeline, {
        level: 'insights',
        principal: principal('owner'),
        features: noCrm,
        companyDataToProvider: true,
        config: approved,
      }),
    ).toBe('feature');
    expect(
      gateOf(pipeline, {
        level: 'insights',
        principal: principal('engineer'),
        features: everything,
        companyDataToProvider: true,
        config: approved,
      }),
    ).toBe('permission');
    const invoices = INSIGHT_TOOLS.find((tool) => tool.key === 'get_invoice_summary')!;
    expect(
      gateOf(invoices, {
        level: 'insights',
        principal: principal('engineer'),
        features: everything,
        companyDataToProvider: true,
        config: approved,
      }),
    ).toBe('permission');
  });

  it('gives an engineer their own jobs, stock and expenses, and nothing of the money', () => {
    const offered = toolsFor(INSIGHT_TOOLS, {
      level: 'insights',
      principal: principal('engineer'),
      features: everything,
      companyDataToProvider: true,
      config: approved,
    }).map((tool) => tool.key);
    expect(offered).toContain('get_my_work_orders');
    expect(offered).toContain('get_my_expense_status');
    expect(offered).not.toContain('get_invoice_summary');
    expect(offered).not.toContain('get_crm_pipeline_summary');
  });

  it('describes a tool to the provider as a JSON schema with its bounds', () => {
    const definition = toProviderDefinition(
      INSIGHT_TOOLS.find((tool) => tool.key === 'get_my_work_orders')!,
    );
    expect(definition.name).toBe('get_my_work_orders');
    expect(JSON.stringify(definition.inputSchema)).toContain('"maximum":20');
  });
});
