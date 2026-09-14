import {
  allIds,
  findField,
  type FormDefinition,
  generateId,
  referencesTo,
} from '@integr8/form-engine';
import { say } from './text';

/**
 * A new question's answer key, taken from its wording once the admin has
 * written it.
 *
 * A question starts life keyed by its kind — `pick_one`, `paragraph` — because
 * it has no wording yet, and that key would become a column heading in every
 * export. So until the key could matter, it follows the wording: "Appliance
 * safe to use?" becomes `appliance_safe_to_use`.
 *
 * "Could matter" is decided strictly. A key that is in any published version is
 * what submissions are stored under, and one that a rule reads is what the rule
 * names; either way it is fixed for good, and this returns `undefined`.
 */
export function keyFromWording(
  definition: FormDefinition,
  fieldId: string,
  locale: string,
  publishedIds: ReadonlySet<string>,
): { definition: FormDefinition; id: string } | undefined {
  const field = findField(definition, fieldId);
  if (
    field === undefined ||
    publishedIds.has(fieldId) ||
    referencesTo(definition, [fieldId]).length > 0
  ) {
    return undefined;
  }
  const wording = say(field.label, locale);
  const others = [...allIds(definition).filter((id) => id !== fieldId), ...publishedIds];
  const id = generateId(wording, 'field', others);
  // A wording with no Latin letters gives back the kind name, which is no better than what it has.
  if (id === fieldId || id === 'field' || /^field_\d+$/u.test(id)) {
    return undefined;
  }
  return {
    id,
    definition: {
      ...definition,
      pages: definition.pages.map((page) => ({
        ...page,
        sections: page.sections.map((section) => ({
          ...section,
          fields: section.fields.map((candidate) =>
            candidate.id === fieldId ? { ...candidate, id } : candidate,
          ),
        })),
      })),
    },
  };
}
