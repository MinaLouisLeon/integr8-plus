import { describe, expect, it } from 'vitest';
import { integr8Look } from './look';

describe('the Integr8 Media look on the desktop app', () => {
  it('is worn by the staff build only', () => {
    expect(integr8Look('staff')).toEqual({ 'data-look': 'integr8' });
    expect(integr8Look('company')).toEqual({});
    expect(integr8Look('development')).toEqual({});
  });
});
