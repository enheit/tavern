import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { theme } from './lib/state/theme.svelte';

theme.init();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
