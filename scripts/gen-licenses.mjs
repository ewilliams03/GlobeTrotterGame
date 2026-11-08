// Writes dist/licenses.txt: the full licence text of every third-party package shipped in the site,
// as the MIT, ISC and SIL OFL licences require copies to carry their notices.
import { readFileSync, writeFileSync } from 'node:fs';

const shipped = [
  ['flag-icons', 'Country flags'],
  ['world-atlas', 'Map shapes (derived from Natural Earth, public domain)'],
  ['d3-geo', 'Map projections'],
  ['d3-array', 'Used by d3-geo'],
  ['internmap', 'Used by d3-array'],
  ['topojson-client', 'Map data decoding'],
  ['@fontsource-variable/bricolage-grotesque', 'Typeface: Bricolage Grotesque'],
  ['@fontsource-variable/instrument-sans', 'Typeface: Instrument Sans'],
  ['@fontsource-variable/jetbrains-mono', 'Typeface: JetBrains Mono'],
];

let out = 'Globetrotter Games: third-party licences\n=========================================\n\n';
out += 'This site includes the following open-source software and assets.\n';
out += 'Fun facts are written in our own words; sources (mostly Wikipedia, CC BY-SA) are linked beside each fact.\n\n';
for (const [pkg, what] of shipped) {
  const meta = JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8'));
  const text = readFileSync(`node_modules/${pkg}/LICENSE`, 'utf8').trim();
  out += `----------------------------------------------------------------\n${pkg} ${meta.version} (${meta.license})\n${what}\n----------------------------------------------------------------\n\n${text}\n\n`;
}
writeFileSync('dist/licenses.txt', out);
console.log(`✓ licenses.txt (${shipped.length} packages)`);
