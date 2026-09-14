/**
 * CSV as spreadsheets write it (RFC 4180): comma-separated, fields quoted with
 * `"` when they contain a comma, a quote or a line break, quotes doubled inside
 * a quoted field, rows ending in CRLF or LF. A leading byte-order mark, which
 * Excel adds when it saves UTF-8, is ignored.
 *
 * Row numbers are the spreadsheet's: the header is row 1, so "row 14" in an
 * import report is the row a person sees as 14 when they open the file — even
 * when a field above it spans several lines.
 */

export interface CsvRow {
  /** The spreadsheet row the record starts on. */
  row: number;
  cells: string[];
}

export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly row: number,
  ) {
    super(message);
    this.name = 'CsvSyntaxError';
  }
}

export function parseCsv(text: string): CsvRow[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let rowStart = 1;

  const endField = () => {
    cells.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // A line with nothing on it is not a record.
    if (!(cells.length === 1 && cells[0] === '')) {
      rows.push({ row: rowStart, cells });
    }
    cells = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') {
          line += 1;
        }
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (fieldStarted && field !== '') {
        throw new CsvSyntaxError('A quote appears in the middle of an unquoted field.', line);
      }
      quoted = true;
      fieldStarted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      endRow();
      line += 1;
      rowStart = line;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (quoted) {
    throw new CsvSyntaxError('A quoted field is never closed.', rowStart);
  }
  if (field !== '' || cells.length > 0) {
    endRow();
  }
  return rows;
}

/** A header as people write one: `Account Number`, `account_number` and `account-number` are one column. */
export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_')
    .replace(/[^a-z0-9_]/gu, '');
}

/** One CSV line, quoting only what must be quoted. For templates, which carry no user text. */
export function csvLine(cells: readonly string[]): string {
  return cells
    .map((cell) => (/[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
    .join(',');
}
