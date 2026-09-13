/**
 * Applies the host's appearance before first paint.
 *
 * Tracefold hosts this plugin inside its own window and passes the active theme and
 * language on the URL. Loaded synchronously from <head> so the page never flashes the
 * wrong palette. Standalone runs fall back to the operating system preference.
 */
(function applyHostAppearance() {
  var root = document.documentElement;

  function normalise(value) {
    return value === 'dark' || value === 'light' ? value : '';
  }

  function fromSystem() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  var params = new URLSearchParams(window.location.search);
  var requested = normalise(params.get('tracefoldTheme'));
  root.dataset.theme = requested || fromSystem();

  var language = params.get('tracefoldLang');
  if (language === 'hu' || language === 'en') root.lang = language;

  if (params.get('host') === 'tracefold') root.dataset.host = 'tracefold';

  var pinned = Boolean(requested);

  // Follow the system only while the host has not pinned a theme.
  if (!pinned && window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (!pinned) root.dataset.theme = fromSystem();
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  // The host announces a later theme or language change rather than reloading the page,
  // so switching appearance in Tracefold does not discard work in progress here.
  window.addEventListener('message', function (event) {
    // Only the window that embedded this page may change its appearance.
    if (event.source !== window.parent || window.parent === window) return;
    var data = event.data;
    if (!data || data.type !== 'tracefold:appearance') return;
    var theme = normalise(data.theme);
    if (theme) {
      pinned = true;
      root.dataset.theme = theme;
    }
    if (data.language === 'hu' || data.language === 'en') root.lang = data.language;
  });
})();
