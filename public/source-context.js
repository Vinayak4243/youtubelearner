(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeSourceContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseTimecode(value) {
    const normalized = String(value || '').trim().replace(',', '.');
    const parts = normalized.split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function parseTranscript(text) {
    const segments = [];
    let current = null;
    const flush = () => {
      if (current && current.text.trim()) segments.push(current);
      current = null;
    };
    for (const line of String(text || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) { flush(); continue; }
      if (/^(WEBVTT|NOTE\b|\d+)$/i.test(trimmed)) continue;
      const cue = trimmed.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)/);
      if (cue) {
        flush();
        const start = parseTimecode(cue[1]);
        const end = parseTimecode(cue[2]);
        if (start !== null) current = { start, end, text: '' };
        continue;
      }
      const inline = trimmed.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)\s+(.+)$/);
      if (inline) {
        flush();
        const start = parseTimecode(inline[1]);
        if (start !== null) current = { start, end: null, text: inline[2] };
        continue;
      }
      if (current) current.text += (current.text ? ' ' : '') + trimmed;
    }
    flush();
    segments.sort((a, b) => a.start - b.start);
    for (let index = 0; index < segments.length; index++) {
      if (segments[index].end === null) segments[index].end = segments[index + 1]?.start ?? segments[index].start + 15;
    }
    return segments;
  }

  function timestampWindow(segments, timestamp, options) {
    const before = options?.beforeSeconds ?? 90;
    const after = options?.afterSeconds ?? 60;
    const start = Math.max(0, Number(timestamp) - before);
    const end = Number(timestamp) + after;
    const selected = (segments || []).filter(segment => segment.end >= start && segment.start <= end);
    return {
      start,
      end,
      segments: selected,
      text: selected.map(segment => `[${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, '0')}] ${segment.text}`).join('\n')
    };
  }

  function pageText(pages, pageNumber) {
    return (pages || []).find(page => Number(page.page) === Number(pageNumber))?.text || '';
  }

  async function extractPdfPages(document, onProgress) {
    const pages = [];
    let text = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageContent = content.items.map(item => item.str || '').join(' ').trim();
      pages.push({ page:pageNumber, text:pageContent });
      text += `\n[page ${pageNumber}]\n${pageContent}`;
      if (onProgress) onProgress(pageNumber, document.numPages);
    }
    return { pages, text:text.trim() };
  }

  return { parseTimecode, parseTranscript, timestampWindow, pageText, extractPdfPages };
});
