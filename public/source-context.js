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

  function selectPdfPages(pages, query, maxChars) {
    const limit = Math.max(1000, Number(maxChars) || 120000);
    const terms = [...new Set(String(query || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
    const ranked = (pages || []).filter(page => page.text && page.text.trim()).map((page, index) => {
      const text = page.text.toLowerCase();
      const score = terms.reduce((total, term) => total + Math.min(5, text.split(term).length - 1), 0);
      return { page, index, score };
    });
    const selected = [];
    let used = 0;
    for (const item of [...ranked].sort((a,b) => b.score - a.score || a.index - b.index)) {
      const remaining = limit - used;
      if (remaining <= 0) break;
      const text = item.page.text.slice(0, remaining);
      selected.push({ page:item.page.page, text });
      used += text.length + 24;
    }
    return selected.sort((a,b) => Number(a.page) - Number(b.page));
  }

  function pdfPageRange(lessonEntries, index, pages) {
    const startPage = Number(lessonEntries[index]?.page);
    if (!Number.isInteger(startPage) || startPage < 1) return [];
    const nextStart = lessonEntries.slice(index + 1)
      .map(entry => Number(entry.page))
      .find(page => Number.isInteger(page) && page > startPage);
    return (pages || []).filter(page => Number(page.page) >= startPage && (!nextStart || Number(page.page) < nextStart));
  }

  async function extractPdfPages(document, onProgress) {
    const pages = [];
    let text = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      // PDF text items are frequently emitted in drawing order. Reconstruct
      // visual lines first so two-column material and equations are less
      // likely to be interleaved before they reach the AI.
      const items = content.items.filter(item => String(item.str || '').trim()).map(item => ({
        text:String(item.str || ''), x:Number(item.transform?.[4]) || 0, y:Number(item.transform?.[5]) || 0
      })).sort((a, b) => Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x);
      const lines = [];
      for (const item of items) {
        const line = lines.at(-1);
        if (line && Math.abs(line.y - item.y) <= 3) line.items.push(item);
        else lines.push({ y:item.y, items:[item] });
      }
      const pageContent = lines.map(line => line.items.sort((a,b) => a.x - b.x).map(item => item.text).join(' ')).join('\n').trim();
      const suspicious = !pageContent || pageContent.length < 24 || /(?:\ufffd|\u0000)/.test(pageContent) || (items.length > 20 && pageContent.replace(/\s/g, '').length < items.length * 0.35);
      pages.push({ page:pageNumber, text:pageContent, extractionQuality:suspicious ? 'low' : 'usable' });
      text += `\n[page ${pageNumber}]\n${pageContent}`;
      if (onProgress) onProgress(pageNumber, document.numPages);
    }
    return { pages, text:text.trim(), lowQualityPages:pages.filter(page => page.extractionQuality === 'low').map(page => page.page) };
  }

  return { parseTimecode, parseTranscript, timestampWindow, pageText, selectPdfPages, pdfPageRange, extractPdfPages };
});
