(() => {
  const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferences still work for this page. */ } };
  let theme = read('vt-theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  let large = read('vt-large-text', 'false') === 'true';
  const render = () => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('large-text', large);
    document.getElementById('themeButton')?.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    document.getElementById('textSizeButton')?.setAttribute('aria-pressed', String(large));
  };
  render();
  document.getElementById('themeButton')?.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; save('vt-theme', theme); render(); });
  document.getElementById('textSizeButton')?.addEventListener('click', () => { large = !large; save('vt-large-text', String(large)); render(); });
})();
