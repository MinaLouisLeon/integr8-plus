import type { CompiledForm } from '../compile.js';
import { compareCodeUnits } from '../canonical.js';
import { dependsOnOf } from '../field-types.js';
import type { FormView } from '../state.js';

/**
 * A form view as plain data, ready for canonical JSON.
 *
 * Maps become objects with sorted keys; nothing is left whose serialised order
 * depends on how an engine happened to build it. This is the shape compared
 * byte for byte between Node and Hermes.
 *
 * A form with repeatable sections also records each entry's visibility and
 * values (P13b). A form without them records exactly what it always did, so
 * the golden lines written before entries existed still hold. In the same way,
 * a form with a `requiredWhen` records which fields are required right now, and
 * one with dependent choices records what each offers.
 */
export function snapshotView(form: CompiledForm, view: FormView): Record<string, unknown> {
  const sortedObject = (map: ReadonlyMap<string, unknown>, keys: readonly string[]) => {
    const object: Record<string, unknown> = {};
    for (const key of [...keys].sort(compareCodeUnits)) {
      object[key] = map.get(key);
    }
    return object;
  };

  const visible: Record<string, boolean> = {};
  for (const id of [...form.elements.keys()].sort(compareCodeUnits)) {
    if (form.elements.get(id)?.entries === undefined) {
      visible[id] = view.visible.get(id) === true;
    }
  }

  const values = sortedObject(view.values, [...view.values.keys()]);

  const snapshot: Record<string, unknown> = {
    status: view.status,
    valid: view.valid,
    visible,
    values,
    errors: view.errors,
    shownErrors: view.shownErrors,
    progress: view.progress,
  };

  if (view.entries.size > 0) {
    const entries: Record<string, unknown> = {};
    for (const section of [...view.entries.keys()].sort(compareCodeUnits)) {
      entries[section] = (view.entries.get(section) ?? []).map((entry) => {
        const fields = [...form.elements.values()]
          .filter((element) => element.entries === section)
          .map((element) => element.id);
        const shown: Record<string, boolean> = {};
        for (const id of [...fields].sort(compareCodeUnits)) {
          shown[id] = entry.visible.get(id) === true;
        }
        return {
          id: entry.id,
          visible: shown,
          values: sortedObject(entry.values, [...entry.values.keys()]),
        };
      });
    }
    snapshot.entries = entries;
  }

  if (form.fields.some((field) => field.requiredWhen !== undefined)) {
    snapshot.required = sortedObject(view.required, [...view.required.keys()]);
  }
  if (form.fields.some((field) => dependsOnOf(field) !== undefined)) {
    snapshot.availableOptions = sortedObject(view.availableOptions, [
      ...view.availableOptions.keys(),
    ]);
  }

  return snapshot;
}
