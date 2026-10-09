import { describe, expect, it } from 'vitest';
import { menuPosition } from './context-menu';

const base = { width: 200, height: 160, viewportWidth: 1000, viewportHeight: 700 };

describe('where the right-click menu opens', () => {
  it('starts at the pointer and runs to the right in English', () => {
    expect(menuPosition({ ...base, x: 300, y: 100, rtl: false })).toEqual({
      inline: 300,
      top: 100,
    });
  });

  it('starts at the pointer and runs to the left in Arabic', () => {
    // 300 from the left is 700 from the right, the start edge in Arabic.
    expect(menuPosition({ ...base, x: 300, y: 100, rtl: true })).toEqual({ inline: 700, top: 100 });
  });

  it('is pulled back inside the window near its far edge and its foot', () => {
    expect(menuPosition({ ...base, x: 950, y: 680, rtl: false })).toEqual({
      inline: 1000 - 200 - 8,
      top: 700 - 160 - 8,
    });
    expect(menuPosition({ ...base, x: 40, y: 0, rtl: true })).toEqual({
      inline: 1000 - 200 - 8,
      top: 8,
    });
  });
});
