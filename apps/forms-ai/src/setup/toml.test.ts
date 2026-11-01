import { describe, expect, it } from 'vitest';
import { getTomlServer, removeTomlTable, setTomlTable } from './toml.js';

const TABLE = ['mcp_servers', 'integr8-forms'];
const server = {
  command: 'C:\\Users\\Mina\\AppData\\Local\\Integr8\\forms-ai\\integr8-forms-ai.exe',
  args: ['serve'],
};

describe('Codex config.toml edits', () => {
  it('appends its table to a file and reads it back', () => {
    const before = 'model = "o4"\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n';
    const after = setTomlTable(before, TABLE, server);
    expect(after).toBe(
      `model = "o4"\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n\n[mcp_servers.integr8-forms]\ncommand = ${JSON.stringify(server.command)}\nargs = ["serve"]\n`,
    );
    expect(getTomlServer(after, TABLE)).toEqual(server);
    expect(setTomlTable(after, TABLE, server)).toBe(after);
    expect(removeTomlTable(after, TABLE)).toBe(before);
  });

  it('creates the file’s first table', () => {
    expect(setTomlTable('', TABLE, { command: '/x', args: ['serve'] })).toBe(
      '[mcp_servers.integr8-forms]\ncommand = "/x"\nargs = ["serve"]\n',
    );
  });

  it('replaces its table in place, sub-tables included, leaving the next table alone', () => {
    const before =
      '[mcp_servers."integr8-forms"]\ncommand = "/old"\nargs = ["serve"]\n\n[mcp_servers."integr8-forms".env]\nX = "1"\n\n[profiles.fast]\nmodel = "mini"\n';
    expect(getTomlServer(before, TABLE)).toEqual({ command: '/old', args: ['serve'] });
    const after = setTomlTable(before, TABLE, { command: '/new', args: ['serve'] });
    expect(after).toBe(
      '[mcp_servers.integr8-forms]\ncommand = "/new"\nargs = ["serve"]\n\n[profiles.fast]\nmodel = "mini"\n',
    );
  });

  it('keeps Windows line endings and removes nothing but its table', () => {
    const before =
      "a = 1\r\n\r\n[mcp_servers.integr8-forms]\r\ncommand = '/x'\r\nargs = ['serve']\r\n\r\n[other]\r\nb = 2\r\n";
    expect(getTomlServer(before, TABLE)).toEqual({ command: '/x', args: ['serve'] });
    expect(removeTomlTable(before, TABLE)).toBe('a = 1\r\n\r\n[other]\r\nb = 2\r\n');
  });

  it('does not mistake a server whose name starts the same', () => {
    const text = '[mcp_servers.integr8-forms-old]\ncommand = "/y"\n';
    expect(getTomlServer(text, TABLE)).toBeUndefined();
    expect(removeTomlTable(text, TABLE)).toBe(text);
  });
});
