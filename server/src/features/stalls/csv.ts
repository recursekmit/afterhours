// Tiny CSV reader/writer for the menu import and the transaction export.

/** Parse CSV or tab-separated text (pasted from a spreadsheet). Handles "quoted, fields" and "" escapes. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRow = () => {
    cells.push(cur);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: startLine, cells: cells.map((c) => c.trim()) });
    cells = [];
    cur = '';
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cur += ch;
      }
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === delim) {
      cells.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      startLine = line;
    } else cur += ch;
  }
  if (cur !== '' || cells.length > 0) endRow();
  return rows;
}

/** One CSV cell. Quotes when needed, and defuses spreadsheet formulas (=, +, -, @). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: (string | number | null | undefined)[]): string => cells.map(csvCell).join(',');
