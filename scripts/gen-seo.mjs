// Post-build SEO: robots.txt always; when SITE_URL is set (e.g. SITE_URL=https://example.com npm run build,
// or a Production env var on Vercel) also sitemap.xml, canonical links, og:url/og:image and site JSON-LD.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const site = (process.env.SITE_URL || '').replace(/\/$/, '');
const pages = {
  '/': 'dist/index.html',
  '/games/globe-links': 'dist/games/globe-links/index.html',
  '/games/fact-or-fib': 'dist/games/fact-or-fib/index.html',
  '/games/rank-the-world': 'dist/games/rank-the-world/index.html',
  '/games/mystery-passport': 'dist/games/mystery-passport/index.html',
  '/games/outline-sketch': 'dist/games/outline-sketch/index.html',
  '/games/flag-forge': 'dist/games/flag-forge/index.html',
  '/about': 'dist/about.html',
  '/privacy': 'dist/privacy.html',
  '/terms': 'dist/terms.html',
};

let robots = 'User-agent: *\nAllow: /\n';

if (site) {
  robots += `\nSitemap: ${site}/sitemap.xml\n`;
  const urls = Object.keys(pages).map((p) => `  <url><loc>${site}${p}</loc></url>`).join('\n');
  writeFileSync('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);

  for (const [path, file] of Object.entries(pages)) {
    if (!existsSync(file)) continue;
    const url = `${site}${path}`;
    let tags = `<link rel="canonical" href="${url}" />\n    <meta property="og:url" content="${url}" />\n    <meta property="og:image" content="${site}/og-image.png" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta name="twitter:card" content="summary_large_image" />`;
    if (path === '/') {
      // JSON-LD is a data block, not executed script, so the strict CSP does not affect it.
      const ld = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Globetrotter Games', url: `${site}/`, description: 'Free daily geography games about countries, flags and cultures.' };
      tags += `\n    <script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    }
    const html = readFileSync(file, 'utf8');
    if (!html.includes('rel="canonical"')) writeFileSync(file, html.replace('</head>', `    ${tags}\n  </head>`));
  }
  console.log(`✓ sitemap.xml, canonical and social tags for ${site}`);
} else {
  console.log('ℹ SITE_URL not set: skipped sitemap.xml and canonical/social tags (robots.txt still written).');
}
writeFileSync('dist/robots.txt', robots);

// Launch checklist: warn loudly if legal placeholders are still in the built pages.
for (const f of ['dist/privacy.html', 'dist/terms.html']) {
  if (existsSync(f) && /\[(OPERATOR NAME|CONTACT EMAIL)\]/.test(readFileSync(f, 'utf8'))) {
    console.warn(`⚠ ${f} still has [OPERATOR NAME] / [CONTACT EMAIL] placeholders. Fill them in before launch.`);
  }
}
if (/TEST_MODE = true/.test(readFileSync('src/shared/testing.ts', 'utf8'))) {
  console.warn('⚠ TEST_MODE is on: every game shows a "Reset today\'s game" button. Set TEST_MODE = false in src/shared/testing.ts before launch.');
}
