import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import { getPlatformDataSource } from '../connection.js';

/**
 * Loads the global template library into `form_templates`.
 *
 * Runs as the schema owner, in every environment — unlike the demo seed, this
 * is product content, not test data. Idempotent: running it twice changes
 * nothing, and running it after a template was edited updates that template.
 */
export async function syncFormTemplates(): Promise<number> {
  return getPlatformDataSource().formTemplates.upsert(
    FORM_TEMPLATES.map((template) => ({
      key: template.key,
      title: template.title,
      description: template.description,
      category: template.category,
      definition: template.definition,
    })),
  );
}
