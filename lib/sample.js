// Sample-data mode: every outbound record link is rewritten to an example.org placeholder,
// so fictional candidates and bills never point at real government records.

export function rewriteForSample(value) {
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value) || /^https?:\/\/(www\.)?example\.org\//i.test(value)) return value;
    try {
      const u = new URL(value);
      return `https://example.org/sample-record/${u.hostname}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return 'https://example.org/sample-record';
    }
  }
  if (Array.isArray(value)) return value.map(rewriteForSample);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = k === 'id' ? v : rewriteForSample(v);
    return out;
  }
  return value;
}
