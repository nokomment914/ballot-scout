// Text helpers. Everything here preserves official wording: we only strip markup,
// collapse whitespace, and cut at a word boundary with an ellipsis. No rewriting.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sect: '§', hellip: '…' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

/** Remove HTML tags (CRS summaries arrive as HTML in CDATA) and normalize whitespace. */
export function stripHtml(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Verbatim excerpt: the first `max` characters of the official text, cut at a word
 * boundary, with an ellipsis when truncated. Returns { text, truncated }.
 */
export function excerpt(text, max = 600) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  let cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) cut = cut.slice(0, lastSpace);
  return { text: `${cut.replace(/[\s,;:]+$/, '')}…`, truncated: true };
}

/**
 * Pull one labeled section out of a New York sponsor memo, verbatim.
 * Memos use upper-case headings such as "JUSTIFICATION:" and "FISCAL IMPLICATIONS:".
 */
export function extractMemoSection(memo, heading) {
  const text = String(memo ?? '').replace(/\r\n?/g, '\n');
  if (!text) return '';
  const pattern = heading instanceof RegExp ? heading : new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^:\\n]{0,80}:`, 'i');
  const m = pattern.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  // Next heading: a line that starts with 3+ upper-case words/characters followed by a colon.
  const next = /\n\s*[A-Z][A-Z0-9 ,'’/&().-]{2,80}:/.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return body.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

export const FISCAL_HEADING = /(FISCAL IMPLICATIONS|BUDGET IMPLICATIONS|FISCAL IMPACT)[^:\n]{0,80}:/i;
export const JUSTIFICATION_HEADING = /JUSTIFICATION[^:\n]{0,40}:/i;

/** Lower-case, accent-free, punctuation-free form used for name comparisons. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[“”"'’.]/g, '')
    .replace(/[^a-z0-9,\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function ordinal(n) {
  const v = Number(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]}`;
}
