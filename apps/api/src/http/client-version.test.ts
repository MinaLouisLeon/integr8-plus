import { describe, expect, it } from 'vitest';
import {
  assessClientVersion,
  compareVersions,
  outdatedClientMessage,
  parseClientVersion,
} from './client-version.js';

describe('parsing', () => {
  it('reads a plain version', () => {
    expect(parseClientVersion('1.4.2')).toEqual({ major: 1, minor: 4, patch: 2 });
  });

  it('ignores a pre-release or build suffix', () => {
    // Refusing these would lock out exactly the people testing the next
    // release, who are the ones most likely to be sending one.
    expect(parseClientVersion('1.4.2-beta.3')).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(parseClientVersion('1.4.2+ci.99')).toEqual({ major: 1, minor: 4, patch: 2 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseClientVersion('  2.0.0 ')).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it('returns undefined for anything it cannot read', () => {
    for (const raw of ['', 'latest', '1.4', 'v1.4.2', null, undefined]) {
      expect(parseClientVersion(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('comparison', () => {
  it('orders by major, then minor, then patch', () => {
    const older = { major: 1, minor: 9, patch: 9 };
    const newer = { major: 2, minor: 0, patch: 0 };

    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
    expect(compareVersions(older, older)).toBe(0);
  });

  it('does not compare version parts as strings', () => {
    // `10` sorts before `9` as text, which is the classic way this goes wrong.
    expect(
      compareVersions({ major: 1, minor: 10, patch: 0 }, { major: 1, minor: 9, patch: 0 }),
    ).toBeGreaterThan(0);
  });
});

describe('the support decision', () => {
  it('serves a current client', () => {
    expect(assessClientVersion('1.4.2', '1.0.0')).toEqual({ supported: true, reason: 'current' });
  });

  it('serves a client exactly at the minimum', () => {
    expect(assessClientVersion('1.0.0', '1.0.0').supported).toBe(true);
  });

  it('refuses a client below the minimum, and says by how much', () => {
    expect(assessClientVersion('0.9.9', '1.0.0')).toEqual({
      supported: false,
      reason: 'too_old',
      minimum: '1.0.0',
      declared: '0.9.9',
    });
  });

  it('serves a client that declares no version', () => {
    // curl, a health check and a partner integration all have good reasons not
    // to send one. Refusing them would make this header a de-facto
    // authentication mechanism it was never designed to be — and the clients
    // that matter here, the ones that cannot be force-updated, do send it.
    expect(assessClientVersion(undefined, '1.0.0')).toEqual({
      supported: true,
      reason: 'not_declared',
    });
    expect(assessClientVersion('', '1.0.0').supported).toBe(true);
    expect(assessClientVersion('nonsense', '1.0.0').supported).toBe(true);
  });

  it('serves everybody when our own minimum is malformed', () => {
    // A misconfiguration on our side must not lock out every customer.
    expect(assessClientVersion('1.0.0', 'not-a-version').supported).toBe(true);
  });
});

describe('the message an out-of-date client shows', () => {
  it('says what happened, what to do, and where to go', () => {
    const message = outdatedClientMessage({
      minimum: '2.0.0',
      declared: '1.4.2',
      updateUrl: 'https://integr8.example/download',
    });

    expect(message).toContain('1.4.2');
    expect(message).toContain('2.0.0');
    expect(message).toContain('https://integr8.example/download');
    // Renderable as-is by a client too old to understand a new error shape.
    expect(message.startsWith('This version')).toBe(true);
  });
});
