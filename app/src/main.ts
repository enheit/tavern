import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { theme } from './lib/state/theme.svelte';
import { restoreSession } from './lib/boot';

theme.init();
void restoreSession(); // keyring → /me → Main (§1 S3.3); no-op in browser dev

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
