import { describe, expect, it } from 'vitest';
import { getEntry, parseJsonc, removeEntry, setEntry } from './jsonc.js';

const entry = { command: '/opt/forms/integr8-forms-ai', args: ['serve'] };

describe('JSON settings edits', () => {
  it('creates a file from nothing', () => {
    const text = setEntry('', 'mcpServers', 'integr8-forms', entry);
    expect(JSON.parse(text)).toEqual({ mcpServers: { 'integr8-forms': entry } });
  });

  it('adds beside other servers, keeping their bytes and the file’s indentation', () => {
    const before =
      '{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x" }\n    }\n}\n';
    const after = setEntry(before, 'mcpServers', 'integr8-forms', entry);
    expect(
      after.startsWith(
        '{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x" },\n        "integr8-forms": {\n            "command"',
      ),
    ).toBe(true);
    expect(parseJsonc(after)).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, 'integr8-forms': entry },
    });
    // Removing it gives back exactly the file the user had.
    expect(removeEntry(after, 'mcpServers', 'integr8-forms')).toBe(before);
  });

  it('adds the section when there is none', () => {
    const before = '{\n  "editor.fontSize": 14\n}\n';
    const after = setEntry(before, 'servers', 'integr8-forms', entry);
    expect(parseJsonc(after)).toEqual({
      'editor.fontSize': 14,
      servers: { 'integr8-forms': entry },
    });
    expect(after.startsWith('{\n  "editor.fontSize": 14,\n  "servers": {')).toBe(true);
  });

  it('fills an empty object and an empty section', () => {
    expect(parseJsonc(setEntry('{}', 'mcpServers', 'integr8-forms', entry))).toEqual({
      mcpServers: { 'integr8-forms': entry },
    });
    expect(
      parseJsonc(setEntry('{ "mcpServers": {} }', 'mcpServers', 'integr8-forms', entry)),
    ).toEqual({
      mcpServers: { 'integr8-forms': entry },
    });
  });

  it('replaces only its own entry and is idempotent', () => {
    const before =
      '{\n  "mcpServers": {\n    "integr8-forms": { "command": "/old/path", "args": ["serve"] },\n    "other": {}\n  }\n}';
    const once = setEntry(before, 'mcpServers', 'integr8-forms', entry);
    expect(getEntry(once, 'mcpServers', 'integr8-forms')).toEqual(entry);
    expect(once.endsWith('\n    "other": {}\n  }\n}')).toBe(true);
    expect(setEntry(once, 'mcpServers', 'integr8-forms', entry)).toBe(once);
  });

  it('keeps comments, trailing commas and Windows line endings (VS Code’s JSONC)', () => {
    const before =
      '// my servers\r\n{\r\n  /* keep me */\r\n  "servers": {\r\n    "github": { "type": "http", "url": "https://example.com" }, // trailing\r\n  },\r\n  "inputs": [],\r\n}\r\n';
    const after = setEntry(before, 'servers', 'integr8-forms', { type: 'stdio', ...entry });
    expect(after).toContain('// my servers\r\n');
    expect(after).toContain('/* keep me */');
    expect(after).toContain('// trailing');
    expect(after).not.toMatch(/[^\r]\n/u);
    expect(getEntry(after, 'servers', 'integr8-forms')).toEqual({ type: 'stdio', ...entry });
    expect(getEntry(after, 'servers', 'github')).toEqual({
      type: 'http',
      url: 'https://example.com',
    });
    expect(removeEntry(after, 'servers', 'integr8-forms')).toBe(before);
  });

  it('removes its entry wherever it is, and nothing when it is absent', () => {
    const first = '{"mcpServers":{"integr8-forms":{"command":"a"},"b":{"command":"b"}}}';
    expect(JSON.parse(removeEntry(first, 'mcpServers', 'integr8-forms'))).toEqual({
      mcpServers: { b: { command: 'b' } },
    });
    const only = '{"mcpServers":{"integr8-forms":{"command":"a"}},"x":1}';
    expect(JSON.parse(removeEntry(only, 'mcpServers', 'integr8-forms'))).toEqual({
      mcpServers: {},
      x: 1,
    });
    expect(removeEntry('{"x":1}', 'mcpServers', 'integr8-forms')).toBe('{"x":1}');
  });

  it('refuses a section that is not an object rather than guessing', () => {
    expect(() => setEntry('{"mcpServers": []}', 'mcpServers', 'integr8-forms', entry)).toThrow(
      /not an object/u,
    );
    expect(() => setEntry('[1, 2]', 'mcpServers', 'integr8-forms', entry)).toThrow(
      /not a JSON object/u,
    );
    expect(() => setEntry('{"a": ', 'mcpServers', 'integr8-forms', entry)).toThrow();
  });

  it('keeps backslashes of Windows paths exact', () => {
    const windows = {
      command: 'C:\\Users\\Mina Leon\\AppData\\Local\\Integr8\\forms-ai\\integr8-forms-ai.exe',
      args: ['serve'],
    };
    expect(
      getEntry(
        setEntry('{}', 'mcpServers', 'integr8-forms', windows),
        'mcpServers',
        'integr8-forms',
      ),
    ).toEqual(windows);
  });
});
