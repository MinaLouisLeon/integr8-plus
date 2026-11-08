/**
 * Every date, time and date-time box in the app opens its picker when it is
 * clicked, not only from the small calendar or clock icon at its end, which
 * is easy to miss and on some screens hard to see.
 *
 * One listener on the document covers the forms, the shared screens and each
 * app's own pages alike, so no screen can forget it. Typing still works: only
 * a click opens the picker, never focus, so a keyboard user tabbing through a
 * form is not interrupted. A browser without `showPicker` (or one that refuses
 * it, such as inside a cross-origin frame) keeps its own behaviour.
 *
 * Returns the function that removes the listener.
 */
const PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

export function openPickersOnClick(target: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) ||
      !PICKER_TYPES.has(input.type) ||
      input.disabled ||
      input.readOnly ||
      typeof input.showPicker !== 'function'
    ) {
      return;
    }
    try {
      input.showPicker();
    } catch {
      // Already open, or not allowed here: the box still takes typing.
    }
  };
  target.addEventListener('click', onClick);
  return () => target.removeEventListener('click', onClick);
}
