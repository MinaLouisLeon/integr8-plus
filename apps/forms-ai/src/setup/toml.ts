/**
 * The one TOML edit the installer makes: Codex's `config.toml` gets, or
 * loses, a `[mcp_servers.integr8-forms]` table, and nothing else in the file
 * changes. The table (with any `[mcp_servers.integr8-forms.<sub>]` tables
 * under it) runs from its header to the next header that is not its own.
 */

export interface TomlServer {
  command: string;
  args: string[];
}

const HEADER = /^[ \t]*\[\[?\s*([^\]]+?)\s*\]\]?[ \t]*(?:#.*)?$/u;

/** A dotted table name with its quoted parts unquoted: `mcp_servers."a b"` → ["mcp_servers", "a b"]. */
function nameParts(name: string): string[] {
  const parts: string[] = [];
  const pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/gu;
  for (const match of name.matchAll(pattern)) {
    if (match[1] !== undefined) {
      parts.push(JSON.parse(`"${match[1]}"`) as string);
    } else {
      parts.push(match[2] ?? match[3] ?? '');
    }
  }
  return parts;
}

function belongs(parts: readonly string[], table: readonly string[]): boolean {
  return table.every((part, index) => parts[index] === part);
}

interface Block {
  /** Line indexes, end exclusive. */
  start: number;
  end: number;
}

function findBlocks(lines: readonly string[], table: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let open: number | undefined;
  lines.forEach((line, index) => {
    const header = HEADER.exec(line);
    if (header === null) {
      return;
    }
    const ours = belongs(nameParts(header[1] ?? ''), table);
    if (ours && open === undefined) {
      open = index;
    } else if (!ours && open !== undefined) {
      blocks.push({ start: open, end: index });
      open = undefined;
    }
  });
  if (open !== undefined) {
    blocks.push({ start: open, end: lines.length });
  }
  return blocks;
}

/** A TOML basic string: JSON's escapes are a subset TOML reads the same. */
const quote = (value: string) => JSON.stringify(value);

function tableText(table: readonly string[], server: TomlServer, eol: string): string {
  const name = table.map((part) => (/^[A-Za-z0-9_-]+$/u.test(part) ? part : quote(part))).join('.');
  return [
    `[${name}]`,
    `command = ${quote(server.command)}`,
    `args = [${server.args.map(quote).join(', ')}]`,
  ].join(eol);
}

const lineEnding = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/** Our table's `command` and `args`, when it is there and readable. */
export function getTomlServer(text: string, table: readonly string[]): TomlServer | undefined {
  const lines = text.split(/\r?\n/u);
  const block = findBlocks(lines, table)[0];
  if (block === undefined) {
    return undefined;
  }
  let command: string | undefined;
  let args: string[] = [];
  for (const line of lines.slice(block.start + 1, block.end)) {
    const commandMatch = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/u.exec(line);
    if (commandMatch?.[1] !== undefined) {
      const raw = commandMatch[1];
      command = raw.startsWith("'") ? raw.slice(1, -1) : (JSON.parse(raw) as string);
    }
    const argsMatch = /^\s*args\s*=\s*\[(.*)\]/u.exec(line);
    if (argsMatch?.[1] !== undefined) {
      args = [...argsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((match) =>
        match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : (match[2] ?? ''),
      );
    }
  }
  return command === undefined ? undefined : { command, args };
}

/** The text with our table removed (every copy), nothing else changed. */
export function removeTomlTable(text: string, table: readonly string[]): string {
  const eol = lineEnding(text);
  let lines = text.split(/\r?\n/u);
  for (const block of findBlocks(lines, table).reverse()) {
    let start = block.start;
    let end = block.end;
    if (end === lines.length) {
      // The last table: the file's final newline stays, and the blank line
      // that separated the table from the one before goes with it.
      if (lines[end - 1] === '') {
        end -= 1;
      }
      while (start > 0 && lines[start - 1]?.trim() === '') {
        start -= 1;
      }
    }
    // Otherwise its own trailing blank lines (inside the block) were the separator.
    lines = [...lines.slice(0, start), ...lines.slice(end)];
  }
  return lines.join(eol);
}

/** The text with our table set to `server`: replaced where it is, or added at the end. */
export function setTomlTable(text: string, table: readonly string[], server: TomlServer): string {
  const eol = lineEnding(text);
  const lines = text.split(/\r?\n/u);
  const blocks = findBlocks(lines, table);
  const first = blocks[0];
  if (first !== undefined) {
    // Keep the blank lines that separated it from the next table.
    let end = first.end;
    while (end > first.start + 1 && lines[end - 1]?.trim() === '') {
      end -= 1;
    }
    const replaced = [
      ...lines.slice(0, first.start),
      ...tableText(table, server, eol).split(eol),
      ...lines.slice(end),
    ].join(eol);
    // Any later copy would make the file invalid TOML.
    const rest = findBlocks(replaced.split(/\r?\n/u), table).slice(1);
    if (rest.length === 0) {
      return replaced;
    }
    const kept = replaced.split(/\r?\n/u);
    for (const block of rest.reverse()) {
      kept.splice(block.start, block.end - block.start);
    }
    return kept.join(eol);
  }
  const trimmed = text.replace(/(?:\r?\n)*$/u, '');
  return `${trimmed === '' ? '' : `${trimmed}${eol}${eol}`}${tableText(table, server, eol)}${eol}`;
}
