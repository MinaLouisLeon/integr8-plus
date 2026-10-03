import { describe, expect, it } from 'vitest';
import { median } from './funnel.js';

/**
 * The one piece of arithmetic in the funnel route. Small, and the kind of
 * thing that is wrong by one for years when nobody writes it down.
 */
describe('the median', () => {
  it('is null for nothing, and the value itself for one', () => {
    expect(median([])).toBeNull();
    expect(median([42])).toBe(42);
  });

  it('takes the middle of an odd list, in value order rather than arrival order', () => {
    expect(median([900, 60, 300])).toBe(300);
  });

  it('averages the two middle values of an even list', () => {
    expect(median([60, 120, 600, 86_400])).toBe(360);
  });

  it('is not moved by one company that took the weekend', () => {
    // The reason it is a median: a mean of these is over a day.
    expect(median([600, 720, 840, 259_200])).toBe(780);
  });

  it('leaves the list it was given alone', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});
