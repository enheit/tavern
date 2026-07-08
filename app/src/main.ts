import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initTheme } from './theme';

initTheme();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
