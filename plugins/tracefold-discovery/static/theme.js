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

  // Follow the system only while the host has not pinned a theme.
  if (!requested && window.matchMedia) {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      root.dataset.theme = fromSystem();
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }
})();
