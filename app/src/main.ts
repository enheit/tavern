import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { theme } from './lib/state/theme.svelte';
import { runtime } from './lib/state/runtime.svelte';
import { restoreSession } from './lib/boot';

theme.init();
void runtime.probe(); // S6.3 runtime requirements (WebCodecs + Linux portal)
void restoreSession(); // keyring → /me → Main (§1 S3.3); no-op in browser dev

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
