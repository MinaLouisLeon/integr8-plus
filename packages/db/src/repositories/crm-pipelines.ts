import { DEFAULT_PIPELINE_STAGES, type StageOutcome } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CrmPipelineStagesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * A company's sales pipelines and their stages (CRM/ERP plan, phase C3).
 *
 * Every company has a default pipeline, made the first time its CRM asks for
 * one rather than by the migration, so a company created tomorrow gets it the
 * same way as one created last year. Making it twice at once leaves one: the
 * unique index on the default decides, and the loser reads the winner's.
 */

export interface PipelineStage {
  id: string;
  pipelineId: string;
  /** Stable; screens translate the built-in ones (`crm.stage.<key>`). */
  key: string;
  label: string;
  position: number;
  /** The usual chance of winning from here, in basis points. */
  probabilityBp: number;
  outcome: StageOutcome;
  archivedAt: Date | null;
}

export interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  /** In order, archived ones included (history may point at them). */
  stages: PipelineStage[];
}

export class CrmPipelinesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The company's default pipeline, made with the standard stages if it has none yet. */
  async ensureDefault(): Promise<Pipeline> {
    const { rows } = await sql<{ id: string }>`
      insert into crm_pipelines (tenant_id, name, is_default)
      values (${this.tenantId}, 'Sales', true)
      on conflict (tenant_id) where is_default do nothing
      returning id
    `.execute(this.db);
    const created = rows[0];
    if (created !== undefined) {
      await this.db
        .insertInto('crm_pipeline_stages')
        .values(
          DEFAULT_PIPELINE_STAGES.map((stage, index) => ({
            tenant_id: this.tenantId,
            pipeline_id: created.id,
            key: stage.key,
            label: stage.label,
            position: index + 1,
            probability_bp: stage.probabilityBp,
            outcome: stage.outcome,
          })),
        )
        .execute();
    }
    const pipeline = await this.db
      .selectFrom('crm_pipelines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow();
    return {
      id: pipeline.id,
      name: pipeline.name,
      isDefault: true,
      stages: await this.stages(pipeline.id),
    };
  }

  /** Every current pipeline, the default first. Makes the default if there is none. */
  async list(): Promise<Pipeline[]> {
    await this.ensureDefault();
    const pipelines = await this.db
      .selectFrom('crm_pipelines')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('archived_at', 'is', null)
      .orderBy('is_default', 'desc')
      .orderBy(sql`lower(name)`)
      .execute();
    const stages = await this.db
      .selectFrom('crm_pipeline_stages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where(
        'pipeline_id',
        'in',
        pipelines.map((pipeline) => pipeline.id),
      )
      .orderBy('position')
      .execute();
    return pipelines.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.is_default,
      stages: stages.filter((stage) => stage.pipeline_id === pipeline.id).map(toStage),
    }));
  }

  async stages(pipelineId: string): Promise<PipelineStage[]> {
    return (
      await this.db
        .selectFrom('crm_pipeline_stages')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('pipeline_id', '=', pipelineId)
        .orderBy('position')
        .execute()
    ).map(toStage);
  }

  async findStage(stageId: string): Promise<PipelineStage | undefined> {
    const row = await this.db
      .selectFrom('crm_pipeline_stages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', stageId)
      .executeTakeFirst();
    return row === undefined ? undefined : toStage(row);
  }

  async findStages(stageIds: readonly string[]): Promise<PipelineStage[]> {
    if (stageIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('crm_pipeline_stages')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(stageIds)])
        .execute()
    ).map(toStage);
  }
}

function toStage(row: Selectable<CrmPipelineStagesTable>): PipelineStage {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    key: row.key,
    label: row.label,
    position: row.position,
    probabilityBp: row.probability_bp,
    outcome: row.outcome,
    archivedAt: row.archived_at,
  };
}
