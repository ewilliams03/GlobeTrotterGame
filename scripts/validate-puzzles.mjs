// Validates Globe Links content. Run: npm run validate  (add --check-urls to test source links)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const categories = JSON.parse(read('src/games/globe-links/categories.json'));
const puzzles = JSON.parse(read('src/games/globe-links/puzzles.json'));
const countryLat = Object.fromEntries([...read('src/data/countries.ts').matchAll(/^\s+([a-z]{2}): \{ name: .*?lat: (-?[\d.]+)/gm)].map((m) => [m[1], Number(m[2])]));
const countryCodes = new Set(Object.keys(countryLat));

const errors = [];
puzzles.forEach((puzzle, i) => {
  const at = `puzzle ${i + 1}`;
  if (puzzle.groups?.length !== 4) return errors.push(`${at}: needs exactly 4 groups`);
  const seen = new Set();
  const cats = puzzle.groups.map((g) => g.category);
  if (new Set(cats).size !== 4) errors.push(`${at}: categories must be distinct`);
  const diffs = puzzle.groups.map((g) => g.difficulty).sort().join();
  if (diffs !== '1,2,3,4') errors.push(`${at}: difficulties must be 1,2,3,4 once each`);

  puzzle.groups.forEach((g) => {
    const cat = categories[g.category];
    if (!cat) return errors.push(`${at}: unknown category "${g.category}"`);
    if (!g.fact || !/^https:\/\//.test(g.sourceUrl ?? '')) errors.push(`${at}/${g.category}: needs a fact and an https sourceUrl`);
    if (g.fact?.includes('—')) errors.push(`${at}/${g.category}: avoid em dashes in copy`);
    if (g.countries?.length !== 4) errors.push(`${at}/${g.category}: needs exactly 4 countries`);
    g.countries.forEach((c) => {
      if (seen.has(c)) errors.push(`${at}: "${c}" appears twice`);
      seen.add(c);
      if (!countryCodes.has(c)) errors.push(`${at}: "${c}" missing from src/data/countries.ts`);
      if (!existsSync(join(root, 'node_modules/flag-icons/flags/4x3', `${c}.svg`))) errors.push(`${at}: no flag file for "${c}"`);
      if (!cat.members.includes(c)) errors.push(`${at}: "${c}" is not a member of "${g.category}"`);
      // Ambiguity: the tile must not also fit any other group on the same board.
      cats.filter((other) => other !== g.category).forEach((other) => {
        if (categories[other]?.members.includes(c)) errors.push(`${at}: "${c}" also fits "${other}" (ambiguous)`);
      });
    });
  });
});

// ---------- Fact or Fib ----------
const fofDays = JSON.parse(read('src/games/fact-or-fib/facts.json'));
const fofCountries = new Set();
fofDays.forEach((day, d) => {
  const at = `fact-or-fib day ${d + 1}`;
  if (day.rounds?.length !== 5) errors.push(`${at}: needs exactly 5 rounds`);
  day.rounds.forEach((r, i) => {
    const where = `${at} round ${i + 1} (${r.country})`;
    if (!countryCodes.has(r.country)) errors.push(`${where}: country missing from src/data/countries.ts`);
    if (!existsSync(join(root, 'node_modules/flag-icons/flags/4x3', `${r.country}.svg`))) errors.push(`${where}: no flag file`);
    if (fofCountries.has(r.country)) errors.push(`${where}: country already used on another day`);
    fofCountries.add(r.country);
    if (r.statements?.length !== 3) errors.push(`${where}: needs exactly 3 statements`);
    const fibs = r.statements.filter((s) => s.fib);
    if (fibs.length !== 1) errors.push(`${where}: needs exactly one fib`);
    if (fibs[0] && !fibs[0].truth) errors.push(`${where}: the fib needs a "truth" correction`);
    r.statements.forEach((s) => {
      if (!s.text || !/^https:\/\//.test(s.sourceUrl ?? '')) errors.push(`${where}: every statement needs text and an https sourceUrl`);
      if (`${s.text}${s.truth ?? ''}`.includes('—')) errors.push(`${where}: avoid em dashes in copy`);
    });
  });
});

// ---------- Rank the World ----------
const rank = JSON.parse(read('src/games/rank-the-world/rank.json'));
rank.days.forEach((day, d) => {
  const at = `rank-the-world day ${d + 1}`;
  if (day.rounds?.length !== 4) errors.push(`${at}: needs exactly 4 rounds`);
  day.rounds.forEach((r, i) => {
    const where = `${at} round ${i + 1} (${r.stat})`;
    const stat = rank.stats[r.stat];
    if (!stat) return errors.push(`${where}: unknown stat`);
    if (r.countries?.length !== 5 || new Set(r.countries).size !== 5) errors.push(`${where}: needs 5 different countries`);
    if (!r.fact || !/^https:\/\//.test(r.sourceUrl ?? '')) errors.push(`${where}: needs a fact and an https sourceUrl`);
    if (`${r.fact}`.includes('—')) errors.push(`${where}: avoid em dashes in copy`);
    const vals = r.countries.map((c) => {
      if (!countryCodes.has(c)) errors.push(`${where}: "${c}" missing from src/data/countries.ts`);
      if (!existsSync(join(root, 'node_modules/flag-icons/flags/4x3', `${c}.svg`))) errors.push(`${where}: no flag file for "${c}"`);
      if (stat.computed === 'lat') {
        if (!stat.labels?.[c]) errors.push(`${where}: no capital label for "${c}"`);
        return countryLat[c];
      }
      if (typeof stat.values?.[c] !== 'number') errors.push(`${where}: no value for "${c}"`);
      return stat.values?.[c];
    });
    // Neighbouring values must be clearly different, so there is exactly one right order.
    const sorted = [...vals].sort((a, b) => a - b);
    for (let k = 1; k < sorted.length; k++) {
      const gap = stat.computed === 'lat' ? sorted[k] - sorted[k - 1] : (sorted[k] - sorted[k - 1]) / Math.max(1, Math.abs(sorted[k]));
      const min = stat.computed === 'lat' ? 1 : 0.05;
      if (!(gap >= min)) errors.push(`${where}: values ${sorted[k - 1]} and ${sorted[k]} are too close to rank fairly`);
    }
  });
});

// ---------- Mystery Passport ----------
const passport = JSON.parse(read('src/games/mystery-passport/passport.json'));
const worldNames = Object.fromEntries([...read('src/data/world.ts').matchAll(/^  ([a-z]{2}): \{ name: '((?:[^'\\]|\\.)*)'|^  ([a-z]{2}): \{ name: "([^"]*)"/gm)].map((m) => [m[1] ?? m[3], (m[2] ?? m[4]).replace(/\\'/g, "'")]));
const worldCodes = new Set(Object.keys(worldNames));
const CLUE_TYPES = ['nature', 'food', 'phrase', 'currency', 'landmark', 'neighbour'];
const mpSeen = new Set();
passport.days.forEach((day, d) => {
  const at = `mystery-passport day ${d + 1}`;
  if (day.countries?.length !== 3) errors.push(`${at}: needs exactly 3 countries`);
  day.countries.forEach((m) => {
    const where = `${at} (${m.country})`;
    if (!worldCodes.has(m.country)) errors.push(`${where}: not in src/data/world.ts`);
    if (!countryCodes.has(m.country)) errors.push(`${where}: missing from src/data/countries.ts (needed for the globe)`);
    if (!existsSync(join(root, 'node_modules/flag-icons/flags/4x3', `${m.country}.svg`))) errors.push(`${where}: no flag file`);
    if (mpSeen.has(m.country)) errors.push(`${where}: country already used on another day`);
    mpSeen.add(m.country);
    if (!m.continent) errors.push(`${where}: needs a continent for the hint`);
    const types = (m.clues ?? []).map((c) => c.type).sort().join();
    if (types !== [...CLUE_TYPES].sort().join()) errors.push(`${where}: needs exactly one clue of each type`);
    (m.clues ?? []).forEach((c) => {
      if (!c.text || !/^https:\/\//.test(c.sourceUrl ?? '')) errors.push(`${where}/${c.type}: needs text and an https sourceUrl`);
      if (c.text?.includes('—')) errors.push(`${where}/${c.type}: avoid em dashes in copy`);
      // The clue must never name the answer.
      const name = (worldNames[m.country] ?? '').toLowerCase();
      if (name && c.text.toLowerCase().includes(name)) errors.push(`${where}/${c.type}: clue names the country`);
    });
  });
});

// ---------- Outline Sketch ----------
const outline = JSON.parse(read('src/games/outline-sketch/outline.json'));
const atlasIds = new Set(JSON.parse(read('node_modules/world-atlas/countries-50m.json')).objects.countries.geometries.map((g) => g.id));
const DISPUTED_SHAPES = ['in', 'cn', 'pk', 'ma', 'ua', 'il', 'cy', 'rs', 'ge', 'md', 'az', 'am', 'so', 'sd', 'ss', 'kr', 'kp', 'jp'];
const osSeen = new Set();
outline.days.forEach((codes, d) => {
  const at = `outline-sketch day ${d + 1}`;
  if (codes.length !== 3) errors.push(`${at}: needs exactly 3 countries`);
  codes.forEach((c) => {
    if (!atlasIds.has(outline.numeric[c])) errors.push(`${at}: no map shape for "${c}" (numeric ${outline.numeric[c]})`);
    if (!worldCodes.has(c)) errors.push(`${at}: "${c}" not in src/data/world.ts`);
    if (!countryCodes.has(c)) errors.push(`${at}: "${c}" missing from src/data/countries.ts (needed for the hint and globe)`);
    if (DISPUTED_SHAPES.includes(c)) errors.push(`${at}: "${c}" has a disputed or sensitive border; leave it out`);
    if (osSeen.has(c)) errors.push(`${at}: "${c}" already used on another day`);
    osSeen.add(c);
  });
});

// ---------- Flag Forge ----------
const ff = JSON.parse(read('src/games/flag-forge/flags.json'));
const SLOTS = { plain: 1, h2: 2, v2: 2, h3: 3, v3: 3, nordic: 2 };
const FF_COLOURS = ['red', 'white', 'blue', 'lightblue', 'green', 'yellow', 'black', 'orange'];
const COLOURED = ['star', 'crescent', 'sun', 'disc'];
const ffSeen = new Set();
ff.days.forEach((codes, d) => {
  const at = `flag-forge day ${d + 1}`;
  if (codes.length !== 3) errors.push(`${at}: needs exactly 3 flags`);
  codes.forEach((c) => {
    const spec = ff.flags[c];
    if (!spec) return errors.push(`${at}: no spec for "${c}"`);
    if (!worldCodes.has(c)) errors.push(`${at}: "${c}" not in src/data/world.ts`);
    if (!existsSync(join(root, 'node_modules/flag-icons/flags/4x3', `${c}.svg`))) errors.push(`${at}: no flag file for "${c}"`);
    if (!ff.sources?.[c]) errors.push(`${at}: "${c}" needs a source article`);
    if (ffSeen.has(c)) errors.push(`${at}: "${c}" already used on another day`);
    ffSeen.add(c);
    if (spec.colors?.length !== SLOTS[spec.layout]) errors.push(`${at}: "${c}" layout ${spec.layout} needs ${SLOTS[spec.layout]} colours`);
    if (!spec.colors.every((x) => FF_COLOURS.includes(x))) errors.push(`${at}: "${c}" uses an unknown colour`);
    if (COLOURED.includes(spec.symbol) !== !!spec.symbolColor) errors.push(`${at}: "${c}" symbol colour missing or not needed`);
  });
});

if (process.argv.includes('--check-urls')) {
  const urls = [...new Set([
    ...puzzles.flatMap((p) => p.groups.map((g) => g.sourceUrl)),
    ...fofDays.flatMap((d) => d.rounds.flatMap((r) => r.statements.map((s) => s.sourceUrl))),
    ...rank.days.flatMap((d) => d.rounds.map((r) => r.sourceUrl)),
    ...Object.values(rank.stats).map((s) => s.sourceUrl),
    ...passport.days.flatMap((d) => d.countries.flatMap((m) => m.clues.map((c) => c.sourceUrl))),
    ...Object.values(ff.sources).map((t) => `https://en.wikipedia.org/wiki/${t}`),
  ])];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'globetrotter-games-source-check' } });
      console.log(`${res.ok ? 'ok ' : 'BAD'} ${res.status} ${url}`);
      if (!res.ok) errors.push(`source link failed (${res.status}): ${url}`);
    } catch (e) {
      errors.push(`source link error: ${url} (${e.message})`);
    }
  }
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`✓ ${puzzles.length} Globe Links puzzles, ${fofDays.length} Fact or Fib days, ${rank.days.length} Rank the World days and ${passport.days.length} Mystery Passport days, ${outline.days.length} Outline Sketch days and ${ff.days.length} Flag Forge days valid`);
