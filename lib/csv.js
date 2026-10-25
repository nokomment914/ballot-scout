// RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF), zero dependencies.

/** Parse CSV text into an array of objects keyed by the header row. */
export function parseCsv(text, { onRow } = {}) {
  const rows = [];
  let header = null;
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = String(text ?? '');
  const pushRow = () => {
    row.push(field);
    field = '';
    if (!header) {
      header = row.map((h) => h.replace(/^﻿/, '').trim());
    } else if (!(row.length === 1 && row[0] === '')) {
      const obj = {};
      header.forEach((h, i) => { obj[h] = row[i] ?? ''; });
      if (onRow) onRow(obj);
      else rows.push(obj);
    }
    row = [];
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { if (s[i + 1] === '\n') i += 1; pushRow(); }
    else field += ch;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}
