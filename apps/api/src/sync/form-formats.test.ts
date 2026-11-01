import { describe, expect, it } from 'vitest';
import { appReadsFormat, definitionFormat, markedTitle, UPDATE_APP_MARK } from './form-formats.js';

describe('which apps open which form formats', () => {
  it('reads the format a definition declares', () => {
    expect(definitionFormat({ schemaVersion: 2 })).toBe(2);
    expect(definitionFormat({ schemaVersion: '2' })).toBe(1);
    expect(definitionFormat({})).toBe(1);
  });

  it('lets every app open format 1, and only 1.3.0 and later open format 2', () => {
    expect(appReadsFormat('0.9.0', 1)).toBe(true);
    expect(appReadsFormat('1.2.4', 2)).toBe(false);
    expect(appReadsFormat('1.3.0', 2)).toBe(true);
    expect(appReadsFormat('1.3.0-beta.1', 2)).toBe(true);
    expect(appReadsFormat('2.0.0', 2)).toBe(true);
  });

  it('serves a caller that declares no version as current, as everywhere else', () => {
    expect(appReadsFormat(undefined, 2)).toBe(true);
    expect(appReadsFormat('not a version', 2)).toBe(true);
  });

  it('treats a format it has no release for as too new for any declared app', () => {
    expect(appReadsFormat('9.0.0', 3)).toBe(false);
  });

  it('marks a name once', () => {
    expect(markedTitle('Boiler')).toBe(`Boiler${UPDATE_APP_MARK}`);
    expect(markedTitle(markedTitle('Boiler'))).toBe(`Boiler${UPDATE_APP_MARK}`);
  });
});
