import { describe, expect, it } from 'vitest';
import { assertProductionReady, corsOrigins, loadApiConfig } from '../../config.js';
import { isAcceptableMediaType } from '../../media/storage.js';
import { csvCell } from './submissions.js';

describe('CSV cells', () => {
  it('quotes only what needs quoting', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(true)).toBe('true');
  });

  it('defuses text a spreadsheet would run as a formula, and leaves numbers alone', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 7700 900000')).toBe("'+44 7700 900000");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5 degrees')).toBe("'-5 degrees");
    expect(csvCell('-5.25')).toBe('-5.25');
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('browser origins', () => {
  it('allows the local clients in development and tests, and nothing elsewhere unless listed', () => {
    expect(corsOrigins(loadApiConfig({ APP_ENV: 'development' }))).toContain(
      'http://localhost:3001',
    );
    expect(corsOrigins(loadApiConfig({ APP_ENV: 'staging' }))).toEqual([]);
    expect(
      corsOrigins(
        loadApiConfig({
          APP_ENV: 'production',
          API_CORS_ORIGINS: 'https://app.integr8.example/, tauri://localhost',
        }),
      ),
    ).toEqual(['https://app.integr8.example', 'tauri://localhost']);
  });

  it('refuses to start production without origins, or with media on local disk', () => {
    expect(() =>
      assertProductionReady(
        loadApiConfig({ APP_ENV: 'production', SENTRY_DSN: 'x', API_RELEASE: 'abc' }),
      ),
    ).toThrow(/API_CORS_ORIGINS[\s\S]*MEDIA_STORAGE|MEDIA_STORAGE[\s\S]*API_CORS_ORIGINS/u);
  });
});

describe('uploadable media types', () => {
  it('accepts what a form collects and refuses what a browser would execute', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'text/plain']) {
      expect(isAcceptableMediaType(type), type).toBe(true);
    }
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'application/xml',
      'nonsense',
    ]) {
      expect(isAcceptableMediaType(type), type).toBe(false);
    }
  });
});
