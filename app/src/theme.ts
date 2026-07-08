type Theme = 'light' | 'dark';

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Follows the OS light/dark preference via `prefers-color-scheme`, and — when
 * running inside the Tauri webview — also the window theme-changed event.
 * S3.1 adds the persisted system→light→dark override cycle on top of this.
 */
export function initTheme(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  applyTheme(mq.matches ? 'dark' : 'light');
  mq.addEventListener('change', (e) => applyTheme(e.matches ? 'dark' : 'light'));

  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      void w.theme().then((t) => {
        if (t) applyTheme(t);
      });
      void w.onThemeChanged(({ payload }) => applyTheme(payload));
    });
  }
}
