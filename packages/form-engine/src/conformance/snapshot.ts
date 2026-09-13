import type { CompiledForm } from '../compile.js';
import { compareCodeUnits } from '../canonical.js';
import type { FormView } from '../state.js';

/**
 * A form view as plain data, ready for canonical JSON.
 *
 * Maps become objects with sorted keys; nothing is left whose serialised order
 * depends on how an engine happened to build it. This is the shape compared
 * byte for byte between Node and Hermes.
 */
export function snapshotView(form: CompiledForm, view: FormView): Record<string, unknown> {
  const visible: Record<string, boolean> = {};
  for (const id of [...form.elements.keys()].sort(compareCodeUnits)) {
    visible[id] = view.visible.get(id) === true;
  }

  const values: Record<string, unknown> = {};
  for (const id of [...view.values.keys()].sort(compareCodeUnits)) {
    values[id] = view.values.get(id);
  }

  return {
    status: view.status,
    valid: view.valid,
    visible,
    values,
    errors: view.errors,
    shownErrors: view.shownErrors,
    progress: view.progress,
  };
}
