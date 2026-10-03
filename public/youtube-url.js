(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeYouTubeUrl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const hosts = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
    'youtu.be',
    'www.youtu.be'
  ]);

  function parseUrl(input) {
    try {
      const url = new URL(String(input || '').trim().replace(/^["']|["']$/g, ''));
      if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname.toLowerCase())
        || url.username || url.password) return null;
      return url;
    } catch (error) {
      return null;
    }
  }

  function videoId(input) {
    const value = String(input || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
    const url = parseUrl(value);
    if (!url) return null;
    const hostname = url.hostname.toLowerCase();
    let id = '';
    if (hostname === 'youtu.be' || hostname === 'www.youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  function normalizePlaylistUrl(input) {
    const url = parseUrl(input);
    const playlistId = url?.searchParams.get('list') || '';
    if (!url || !/^[A-Za-z0-9_-]{10,128}$/.test(playlistId)) return null;
    return 'https://www.youtube.com/playlist?list=' + encodeURIComponent(playlistId);
  }

  return { videoId, normalizePlaylistUrl };
});
