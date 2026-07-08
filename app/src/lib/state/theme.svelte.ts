import { getPref, setPref } from '../prefs';

export type ThemeMode = 'system' | 'light' | 'dark';
type Applied = 'light' | 'dark';

const KEY = 'tavern.theme';
const CYCLE: ThemeMode[] = ['system', 'light', 'dark'];

function osTheme(): Applied {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Theme = OS preference by default; a persisted override cycles system→light→dark.
// OS/Tauri theme changes only re-apply while in 'system'.
export class ThemeStore {
  mode = $state<ThemeMode>('system');

  init(): void {
    const saved = getPref(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') this.mode = saved;

    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', () => this.mode === 'system' && this.apply());

    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
        getCurrentWindow().onThemeChanged(() => this.mode === 'system' && this.apply()),
      );
    }

    this.apply();
  }

  cycle(): void {
    this.mode = CYCLE[(CYCLE.indexOf(this.mode) + 1) % CYCLE.length];
    setPref(KEY, this.mode);
    this.apply();
  }

  private apply(): void {
    const t: Applied = this.mode === 'system' ? osTheme() : this.mode;
    document.documentElement.setAttribute('data-theme', t);
  }
}

export const theme = new ThemeStore();
