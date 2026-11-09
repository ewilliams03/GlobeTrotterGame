import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import securityHeaders from './security-headers.json';
import browserslist from 'browserslist';
import { browserslistToTargets } from 'lightningcss';
// @ts-expect-error plain JS build helper
import { buildBanks, bankSizes } from './scripts/banks.mjs';

const root = __dirname;

/** Serve clean URLs locally (/about → about.html, /games/x → games/x/index.html), like Vercel's cleanUrls. */
function cleanUrls(): Plugin {
  const rewrite = (base: string) => (req: { url?: string }, _res: unknown, next: () => void) => {
    const [path, query = ''] = (req.url ?? '/').split('?');
    if (path !== '/' && !/\.[a-z0-9]+$/i.test(path)) {
      const p = path.replace(/\/$/, '');
      if (existsSync(resolve(base, `.${p}.html`))) req.url = `${p}.html${query && '?' + query}`;
      else if (existsSync(resolve(base, `.${p}/index.html`))) req.url = `${p}/index.html${query && '?' + query}`;
    }
    next();
  };
  return {
    name: 'clean-urls',
    configureServer(server) {
      server.middlewares.use(rewrite(root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite(resolve(root, 'dist')));
    },
  };
}

/**
 * Daily puzzle files: /data/<game>/<n>.json, one per day.
 * Dev: served live from the bank files (edits show up on refresh). Build: emitted as static files.
 */
function dailyFiles(): Plugin {
  return {
    name: 'daily-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/data\/([a-z-]+)\/(\d+)\.json$/.exec((req.url ?? '').split('?')[0]);
        if (!m) return next();
        const day = buildBanks(root)[m[1]]?.[Number(m[2])];
        if (!day) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(day));
      });
    },
    generateBundle() {
      const banks = buildBanks(root);
      for (const [game, days] of Object.entries(banks) as [string, unknown[]][]) {
        days.forEach((day, i) => this.emitFile({ type: 'asset', fileName: `data/${game}/${i}.json`, source: JSON.stringify(day) }));
      }
    },
  };
}

export default defineConfig({
  // How many days each bank has, baked into the code so a page knows which file is today's.
  define: { __BANK_SIZES__: JSON.stringify(bankSizes(buildBanks(root))) },
  // Multi-page static site: unknown URLs get a real 404, never a silent fallback to the home page.
  appType: 'mpa',
  plugins: [cleanUrls(), dailyFiles()],
  // Lightning CSS adds plain-colour fallbacks for oklch()/color-mix() etc. on older browsers
  // (e.g. iOS 15/16 Safari), so selected states and fills never disappear.
  css: {
    transformer: 'lightningcss',
    lightningcss: { targets: browserslistToTargets(browserslist('>= 0.25%, last 3 versions, safari >= 15, ios_saf >= 15, not dead')) },
  },
  // `vite preview` serves the production build with the same headers Vercel will send.
  preview: { headers: securityHeaders },
  build: {
    cssMinify: 'lightningcss',
    // Modern browsers only (top-level await is used to load today's puzzle file).
    target: 'es2022',
    // Never inline assets as data: URIs, so the strict CSP (img-src/font-src 'self') holds.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: resolve(root, 'index.html'),
        globeLinks: resolve(root, 'games/globe-links/index.html'),
        factOrFib: resolve(root, 'games/fact-or-fib/index.html'),
        rankTheWorld: resolve(root, 'games/rank-the-world/index.html'),
        mysteryPassport: resolve(root, 'games/mystery-passport/index.html'),
        outlineSketch: resolve(root, 'games/outline-sketch/index.html'),
        flagForge: resolve(root, 'games/flag-forge/index.html'),
        privacy: resolve(root, 'privacy.html'),
        about: resolve(root, 'about.html'),
        admin: resolve(root, 'admin.html'),
        terms: resolve(root, 'terms.html'),
        notFound: resolve(root, '404.html'),
      },
    },
  },
});
