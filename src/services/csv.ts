/**
 * Shared CSV cell escaping for every export (audit C-1).
 *
 * Text cells are quoted when they hold a comma, quote or line break (quotes doubled), and a
 * cell that starts with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'` so a spreadsheet
 * never evaluates imported text (signal names, bus names, DBC comments) as a formula.
 * Use it for text only: numbers are written as they are.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

/** Splits one CSV line into cells, honouring double quotes (`""` is a quote). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Like [csvCell] but always quoted (headers that keep a stable quoted form). */
export function csvQuoted(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * RFC 4180 reader: records end at LF, CRLF or CR outside quotes, so a quoted cell may hold line
 * breaks, commas and doubled quotes. Fully empty lines are skipped. Never throws; an unterminated
 * quote runs to the end of the text.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let touched = false;
  const endRecord = () => {
    row.push(cur);
    if (row.length > 1 || row[0] !== '' || touched) records.push(row);
    row = [];
    cur = '';
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      touched = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
      touched = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else cur += ch;
  }
  if (cur !== '' || row.length > 0 || touched) endRecord();
  return records;
}
