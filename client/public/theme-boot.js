/*
 * First paint: stamps the saved theme onto <html data-theme> before the stylesheet loads,
 * so the page never paints a ground that belongs to no theme. Mirrors the resolution in
 * src/theme/useTheme.ts: the stored id, else the light OS preference (paper), else midnight.
 * Keep FIRST_PAINT_THEMES equal to the registry ids and the storage key equal to
 * THEME_STORAGE_KEY; src/theme/firstPaint.test.ts checks both.
 */
(function () {
  const FIRST_PAINT_THEMES = ['midnight', 'paper', 'swiss', 'amber', 'sea', 'paper-deut', 'contrast'];
  let id = null;
  try {
    id = localStorage.getItem('flowmap.theme');
  } catch {
    id = null;
  }
  if (FIRST_PAINT_THEMES.indexOf(id) < 0) {
    id = 'midnight';
    try {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) id = 'paper';
    } catch {
      id = 'midnight';
    }
  }
  document.documentElement.setAttribute('data-theme', id);
})();
