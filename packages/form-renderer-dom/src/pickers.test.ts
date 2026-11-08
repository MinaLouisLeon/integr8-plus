import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPickersOnClick } from './pickers.js';

let stop: () => void = () => undefined;

afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

function box(type: string, attributes: { disabled?: boolean; readOnly?: boolean } = {}) {
  const input = document.createElement('input');
  input.type = type;
  input.disabled = attributes.disabled ?? false;
  input.readOnly = attributes.readOnly ?? false;
  const showPicker = vi.fn();
  input.showPicker = showPicker;
  document.body.append(input);
  return { input, showPicker };
}

describe('date and time pickers', () => {
  it('opens the picker of a date, time or date-time box clicked anywhere', () => {
    stop = openPickersOnClick();
    for (const type of ['date', 'time', 'datetime-local']) {
      const { input, showPicker } = box(type);
      input.click();
      expect(showPicker).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves other boxes, and disabled or read-only ones, alone', () => {
    stop = openPickersOnClick();
    const text = box('text');
    const disabled = box('date', { disabled: true });
    const readOnly = box('date', { readOnly: true });
    text.input.click();
    disabled.input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    readOnly.input.click();
    expect(text.showPicker).not.toHaveBeenCalled();
    expect(disabled.showPicker).not.toHaveBeenCalled();
    expect(readOnly.showPicker).not.toHaveBeenCalled();
  });

  it('keeps the box working when the browser refuses to open the picker', () => {
    stop = openPickersOnClick();
    const { input, showPicker } = box('date');
    showPicker.mockImplementation(() => {
      throw new DOMException('Not allowed', 'NotAllowedError');
    });
    expect(() => input.click()).not.toThrow();
  });

  it('stops when asked', () => {
    openPickersOnClick()();
    const { input, showPicker } = box('date');
    input.click();
    expect(showPicker).not.toHaveBeenCalled();
  });
});
