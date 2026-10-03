(function (root, factory) {
  const routes = factory();
  if (typeof module === 'object' && module.exports) module.exports = routes;
  else root.AdaptPracticeAuthRoutes = routes;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const routeModes = {
    signup: 'signup',
    signin: 'login',
    'forgot-password': 'forgot',
    'reset-password': 'reset'
  };
  const modeRoutes = Object.fromEntries(Object.entries(routeModes).map(([route, mode]) => [mode, route]));

  function modeFromHash(hash) {
    const route = String(hash || '').replace(/^#\/?/, '').replace(/\/+$/, '');
    return routeModes[route] || null;
  }

  function hashForMode(mode) {
    const route = modeRoutes[mode];
    return route ? '#/' + route : '';
  }

  function field(label, control, escapeAttribute) {
    const id = control.match(/\bid="([^"]+)"/)?.[1];
    const escapedId = id && escapeAttribute ? escapeAttribute(id) : id;
    return '<div class="field"><label class="f"' + (id ? ' for="' + escapedId + '"' : '') + '>' + label + '</label>' + control + '</div>';
  }

  return { modeFromHash, hashForMode, field };
});
