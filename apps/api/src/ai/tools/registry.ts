import {
  type AiDataClass,
  type AiLevel,
  aiLevelAtLeast,
  hasFeature,
  holds,
  type ModuleFeature,
  type Permission,
  type Principal,
} from '@integr8/core';
import type { TenantTransaction } from '@integr8/db';
import { z } from 'zod';
import type { ApiConfig } from '../../config.js';
import { approvedDataClasses } from '../providers/index.js';
import type { AiToolDefinition } from '../providers/index.js';

/**
 * The tools the model may be offered, and the gates on each (docs/ai §8.1;
 * ADR-0001 D1, D5).
 *
 * A tool is offered only when every gate opens: the company's level includes
 * it, the seat holds its permission, the company has its module, and the
 * provider is approved for its data class *and* the company has agreed its
 * data may go there. The same gates are checked again at execution with a
 * fresh principal, because what was true when the prompt was built may have
 * changed by the time the model answers.
 *
 * A tool runs inside the caller's tenant transaction over the repositories the
 * screens use. It never sees a table name, a SQL fragment or a tenant id from
 * the model: its arguments are parsed by its own schema and nothing else.
 */

export interface ToolContext {
  principal: Principal;
  tx: TenantTransaction;
  features: Readonly<Record<string, boolean>>;
  locale: 'en' | 'ar';
  now: Date;
}

export interface AiTool<Input, Output> {
  key: string;
  description: string;
  minLevel: Exclude<AiLevel, 'off'>;
  permission: Permission | readonly Permission[];
  feature?: ModuleFeature;
  dataClass: AiDataClass;
  inputSchema: z.ZodType<Input>;
  /** How many rows at most a result may carry. */
  maxRows: number;
  execute(context: ToolContext, input: Input): Promise<Output>;
  /** What the person is shown as the tool's result, one short line. */
  summarise(output: Output, locale: 'en' | 'ar'): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAiTool = AiTool<any, any>;

export function defineTool<Input, Output>(tool: AiTool<Input, Output>): AnyAiTool {
  return tool;
}

export interface ToolGateInput {
  level: AiLevel;
  principal: Principal;
  features: Readonly<Record<string, boolean>>;
  companyDataToProvider: boolean;
  config: ApiConfig;
}

/** Why a tool is not offered, for the capabilities screen and the logs. */
export type ToolGate = 'level' | 'permission' | 'feature' | 'data_class' | null;

export function gateOf(tool: AnyAiTool, input: ToolGateInput): ToolGate {
  if (!aiLevelAtLeast(input.level, tool.minLevel)) {
    return 'level';
  }
  const permissions = typeof tool.permission === 'string' ? [tool.permission] : tool.permission;
  if (!permissions.some((permission) => holds(input.principal, permission))) {
    return 'permission';
  }
  if (tool.feature !== undefined && !hasFeature(input.features, tool.feature)) {
    return 'feature';
  }
  if (tool.dataClass !== 'public_help') {
    if (!input.companyDataToProvider) {
      return 'data_class';
    }
    if (!approvedDataClasses(input.config.AI_PROVIDER, input.config).includes(tool.dataClass)) {
      return 'data_class';
    }
  }
  return null;
}

/** The tools this member may use now, from the registry given. */
export function toolsFor(registry: readonly AnyAiTool[], input: ToolGateInput): AnyAiTool[] {
  return registry.filter((tool) => gateOf(tool, input) === null);
}

/** A tool as the provider is told about it. */
export function toProviderDefinition(tool: AnyAiTool): AiToolDefinition {
  return {
    name: tool.key,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
  };
}

/** Bounded, so a model that asks for everything gets a page. */
export const boundedLimit = (max: number) => z.number().int().min(1).max(max).default(max);

/** `YYYY-MM-DD`, the only date shape a tool accepts. */
export const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
