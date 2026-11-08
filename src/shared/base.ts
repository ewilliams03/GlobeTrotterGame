// Shared page setup: self-hosted fonts (no third-party font requests), base styles, header state.
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import './base.css';

const header = document.querySelector<HTMLElement>('.site-header');
if (header) {
  const onScroll = () => header.toggleAttribute('data-scrolled', window.scrollY > 4);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

document.querySelectorAll<HTMLElement>('[data-year]').forEach((el) => {
  el.textContent = String(new Date().getFullYear());
});

/* ---------- Bottom tab bar for phones (and the installed app, which has no browser back button) ---------- */
import { icon } from './icons';
(() => {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const tabs: [string, string, string, boolean][] = [
    ['/', 'Games', 'home', path === '/' || path.startsWith('/games')],
    ['/#report', 'Today', 'report', false],
    ['/about', 'About', 'info', path === '/about'],
  ];
  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  nav.setAttribute('aria-label', 'App');
  for (const [href, label, ic, current] of tabs) {
    const a = document.createElement('a');
    a.href = href;
    if (current) a.setAttribute('aria-current', 'page');
    const text = document.createElement('span');
    text.textContent = label;
    a.append(icon(ic, 22), text);
    nav.append(a);
  }
  document.body.append(nav);
  // On the landing page, "Today" lights up while the report card is the target.
  if (path === '/') {
    const [games, today] = nav.querySelectorAll('a');
    const sync = () => {
      const onReport = window.location.hash === '#report';
      games.toggleAttribute('aria-current', !onReport);
      if (!onReport) games.setAttribute('aria-current', 'page');
      if (onReport) today.setAttribute('aria-current', 'page');
      else today.removeAttribute('aria-current');
    };
    sync();
    window.addEventListener('hashchange', sync);
  }
})();
