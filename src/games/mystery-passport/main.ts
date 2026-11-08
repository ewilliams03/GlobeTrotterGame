import '../../shared/base';
import '../../shared/game.css';
import './mp.css';
import { COUNTRIES } from '../../data/countries';
import { WORLD, normalise } from '../../data/world';
import { dayIndex, dayKey, msUntilTomorrow } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';
import { icon } from '../../shared/icons';
import { loadToday, showLoadError } from '../../shared/bank';

/* ---------- Types & data ---------- */
type ClueType = 'nature' | 'food' | 'phrase' | 'currency' | 'landmark' | 'neighbour';
interface Clue {
  type: ClueType;
  text: string;
  sourceUrl: string;
}
interface Mystery {
  country: string;
  continent: string;
  clues: Clue[];
}
interface Passport {
  opened: ClueType[]; // in the order the player opened them
  misses: string[]; // wrong guesses (country codes)
  hinted: boolean;
  solved: boolean;
  failed: boolean;
}
interface State {
  passports: Passport[];
  fp?: string; // which puzzle this progress belongs to
  cursor: number;
  done: boolean;
  counted: boolean;
}

const START = 100;
const MISS_COST = 10;
const MAX_MISSES = 3;
const FREE_HINTS = 2;
const ORDER: ClueType[] = ['nature', 'food', 'phrase', 'currency', 'landmark', 'neighbour'];
const LABEL: Record<ClueType, string> = { nature: 'Nature', food: 'Food', phrase: 'Greeting', currency: 'Currency', landmark: 'Landmark', neighbour: 'Neighbour' };
const ICON: Record<ClueType, string> = { nature: 'leaf', food: 'bowl', phrase: 'speech', currency: 'coin', landmark: 'columns', neighbour: 'compass' };

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flag = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';
const nameOf = (code: string) => WORLD[code]?.name ?? COUNTRIES[code]?.name ?? code.toUpperCase();

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const { costs: COSTS, countries: mysteries } = await loadToday<{ costs: Record<ClueType, number>; countries: Mystery[] }>('mystery-passport').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
const ROUNDS = mysteries.length;
const MAX = ROUNDS * START;

const STATE_KEY = `mystery-passport:day:${todayKey}`;
const FP = mysteries.map((m) => m.country).join();
const STATS_KEY = 'mystery-passport:stats';

const freshPassport = (): Passport => ({ opened: ['nature'], misses: [], hinted: false, solved: false, failed: false });
function sanitize(s: State | null): State {
  const fresh: State = { passports: mysteries.map(freshPassport), cursor: 0, done: false, counted: false, fp: FP };
  // Progress saved for a different puzzle (e.g. after the puzzle bank changes) is discarded.
  if (s && s.fp !== FP) return fresh;
  if (!s || !Array.isArray(s.passports) || s.passports.length !== ROUNDS) return fresh;
  const ok = s.passports.every((p) => Array.isArray(p.opened) && p.opened.every((t) => t in COSTS) && Array.isArray(p.misses) && p.misses.every((m) => m in WORLD));
  if (!ok) return fresh;
  s.cursor = Math.min(Math.max(0, s.cursor | 0), ROUNDS - 1);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => state.passports.filter((p) => p.hinted).length;
const worth = (p: Passport) =>
  p.failed ? 0 : Math.max(0, START - p.opened.reduce((n, t) => n + COSTS[t], 0) - p.misses.length * MISS_COST);
const score = () => state.passports.reduce((n, p) => n + (p.solved ? worth(p) : 0), 0);
const finished = (p: Passport) => p.solved || p.failed;

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = $('card');
const stampsEl = $('stamps');
const input = $<HTMLInputElement>('guess-input');
const listEl = $('guess-list');
const guessBtn = $<HTMLButtonElement>('guess-btn');
const hintBtn = $<HTMLButtonElement>('hint');
const statusEl = $('status');
const mini = miniGlobe($('mini-globe'));
let busy = false;

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Rendering ---------- */
function renderTrip() {
  $('trip').replaceChildren(
    ...mysteries.map((m, i) => {
      const p = state.passports[i];
      const li = document.createElement('li');
      if (finished(p)) {
        li.className = 'is-done';
        li.dataset.level = p.solved ? '1' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      if (finished(p)) {
        const img = document.createElement('img');
        img.src = flag(m.country);
        img.alt = '';
        stop.append(img);
      } else {
        stop.textContent = String(i + 1);
      }
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = finished(p) ? `Passport ${i + 1}: ${nameOf(m.country)}` : `Passport ${i + 1}${i === state.cursor ? ', current' : ''}`;
      li.append(stop, label);
      return li;
    }),
  );
}

function renderStamps(fresh?: ClueType) {
  const i = state.cursor;
  const p = state.passports[i];
  const m = mysteries[i];
  const over = finished(p);
  stampsEl.replaceChildren(
    ...ORDER.map((type) => {
      const clue = m.clues.find((c) => c.type === type)!;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stamp-slot';
      btn.dataset.type = type;
      const open = p.opened.includes(type) || over;
      const label = document.createElement('span');
      label.className = 'stamp-label';
      label.textContent = LABEL[type];
      if (open) {
        btn.classList.add('is-open');
        if (type === fresh) btn.classList.add('is-new');
        btn.disabled = true;
        const text = document.createElement('span');
        text.className = 'stamp-text';
        text.textContent = clue.text;
        btn.append(label, text);
        btn.setAttribute('aria-label', `${LABEL[type]}: ${clue.text}`);
        if (over) {
          const a = document.createElement('a');
          a.className = 'stamp-src';
          a.href = clue.sourceUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Source';
          btn.append(a);
          // A link can't live inside a disabled button for keyboard users, so use a div instead.
          const div = document.createElement('div');
          div.className = btn.className;
          div.dataset.type = type;
          div.append(...btn.childNodes);
          li.append(div);
          return li;
        }
      } else {
        btn.classList.add('is-locked');
        const ic = document.createElement('span');
        ic.className = 'stamp-icon';
        ic.append(icon(ICON[type], 26));
        const cost = document.createElement('span');
        cost.className = 'stamp-cost';
        cost.textContent = `−${COSTS[type]}`;
        btn.append(ic, label, cost);
        btn.setAttribute('aria-label', `Unlock the ${LABEL[type].toLowerCase()} clue for ${COSTS[type]} points`);
        btn.disabled = busy;
      }
      li.append(btn);
      return li;
    }),
  );
}

function renderMisses() {
  const p = state.passports[state.cursor];
  $('misses').replaceChildren(
    ...p.misses.map((c) => {
      const li = document.createElement('li');
      li.textContent = nameOf(c);
      return li;
    }),
  );
}

function renderHint() {
  const left = FREE_HINTS - hintsUsed();
  $('hint-count').textContent = String(left);
  hintBtn.setAttribute('aria-label', `Use a hint. ${left} of ${FREE_HINTS} left.`);
  const p = state.passports[state.cursor];
  hintBtn.disabled = busy || state.done || finished(p) || p.hinted || left <= 0;
  const line = $('hint-line');
  if (p.hinted && !finished(p)) {
    const m = mysteries[state.cursor];
    line.textContent = `Hint: it's in ${m.continent}, and its name starts with "${nameOf(m.country)[0]}".`;
    line.hidden = false;
  } else {
    line.hidden = true;
  }
}

function renderCard(fresh?: ClueType) {
  const i = state.cursor;
  const p = state.passports[i];
  $('card-step').textContent = `Passport ${i + 1} of ${ROUNDS}`;
  $('card-title').textContent = finished(p) ? nameOf(mysteries[i].country) : 'Mystery country';
  $('worth').textContent = String(worth(p));
  renderStamps(fresh);
  renderMisses();
  renderHint();
  const over = finished(p);
  $('guess-area').hidden = over;
  $('after').hidden = !over;
  if (over) renderReveal();
  else if (!statusEl.textContent) statusEl.textContent = 'Unlock stamps for clues, then guess the country.';
  renderTrip();
  syncMini();
}

function renderReveal() {
  const i = state.cursor;
  const p = state.passports[i];
  const m = mysteries[i];
  statusEl.textContent = '';
  const box = $('reveal');
  const img = document.createElement('img');
  img.src = flag(m.country);
  img.alt = '';
  const body = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = nameOf(m.country);
  const sub = document.createElement('p');
  const used = p.opened.length;
  sub.textContent = p.solved
    ? `Solved with ${used} ${used === 1 ? 'stamp' : 'stamps'}${p.misses.length ? ` and ${p.misses.length} wrong ${p.misses.length === 1 ? 'guess' : 'guesses'}` : ''}.`
    : 'Out of guesses. Every stamp is open above, with sources.';
  body.append(h, sub);
  const visa = document.createElement('span');
  visa.className = 'visa' + (p.solved ? '' : ' is-denied');
  visa.textContent = p.solved ? 'Entry granted' : 'Entry denied';
  box.replaceChildren(img, body, visa);
  const v = $('verdict');
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.dataset.level = p.solved && worth(p) >= 60 ? '1' : p.solved ? '3' : '4';
  pts.textContent = `+${p.solved ? worth(p) : 0}`;
  v.replaceChildren(document.createTextNode(p.solved ? (worth(p) >= 80 ? 'Brilliant.' : worth(p) >= 50 ? 'Nicely done.' : 'Got there.') : 'Next time.'), pts);
  $('next').textContent = i === ROUNDS - 1 ? 'See your results' : 'Next passport';
}

function syncMini() {
  // Never point the globe at an unsolved country: that would give it away.
  const dots = mysteries.flatMap((m, i) => {
    const p = state.passports[i];
    if (!finished(p)) return [];
    const c = COUNTRIES[m.country];
    return c ? [{ lon: c.lon, lat: c.lat, level: p.solved ? 1 : 4 }] : [];
  });
  mini.setDots(dots);
  const current = mysteries[state.cursor];
  const c = COUNTRIES[current.country];
  if (finished(state.passports[state.cursor]) && c) mini.focus([c]);
}

/* ---------- Autocomplete (all 194 countries, so the list never hints at the answer) ---------- */
const ENTRIES = Object.entries(WORLD).map(([code, w]) => ({
  code,
  name: w.name,
  keys: [w.name, ...(w.aka ?? [])].map(normalise),
}));
let matches: typeof ENTRIES = [];
let active = -1;
let navigated = false; // true once the player picks a suggestion with the arrow keys

function suggest() {
  const q = normalise(input.value);
  const p = state.passports[state.cursor];
  if (!q) {
    closeList();
    return;
  }
  matches = findMatches(q, p.misses);
  active = matches.length ? 0 : -1;
  navigated = false;
  drawList();
}

function findMatches(q: string, misses: string[]) {
  return ENTRIES.filter((e) => !misses.includes(e.code))
    .map((e) => ({ e, rank: Math.min(...e.keys.map((k) => (k === q ? -1 : k.startsWith(q) ? 0 : k.split(' ').some((w) => w.startsWith(q)) ? 1 : k.includes(q) ? 2 : 9))) }))
    .filter((x) => x.rank < 9)
    .sort((a, b) => a.rank - b.rank || a.e.name.localeCompare(b.e.name))
    .slice(0, 6)
    .map((x) => x.e);
}

function drawList() {
  if (!matches.length) {
    closeList();
    return;
  }
  listEl.replaceChildren(
    ...matches.map((m, idx) => {
      const li = document.createElement('li');
      li.id = `opt-${m.code}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(idx === active));
      li.dataset.code = m.code;
      li.textContent = m.name;
      return li;
    }),
  );
  listEl.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${matches[active].code}`);
}

function closeList() {
  matches = [];
  active = -1;
  listEl.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function resolveGuess(): string | null {
  const q = normalise(input.value);
  // An exact name or alias always wins ("UK" is the United Kingdom, not Ukraine).
  const exact = ENTRIES.find((e) => e.keys.includes(q));
  if (exact) return exact.code;
  // Otherwise only guess a suggestion the player chose, or the single remaining match,
  // so a half-typed name never spends a guess by accident.
  if (navigated && active >= 0 && matches[active]) return matches[active].code;
  if (matches.length === 1) return matches[0].code;
  // The list may have been closed (Escape, tapping away); judge the typed text afresh.
  if (!matches.length && q) {
    const again = findMatches(q, state.passports[state.cursor].misses);
    if (again.length === 1) return again[0].code;
  }
  return null;
}

/* ---------- Actions ---------- */
function unlock(type: ClueType) {
  const p = state.passports[state.cursor];
  if (busy || finished(p) || p.opened.includes(type)) return;
  haptic.tap();
  p.opened.push(type);
  persist();
  statusEl.textContent = `${LABEL[type]} stamp unlocked: −${COSTS[type]} points.`;
  renderCard(type);
  (stampsEl.querySelector<HTMLElement>('button.is-locked:not(:disabled)') ?? input).focus({ preventScroll: true });
}

function guess() {
  const i = state.cursor;
  const p = state.passports[i];
  if (busy || finished(p)) return;
  const code = resolveGuess();
  if (code) closeList();
  if (!code) {
    const typed = normalise(input.value);
    const some = matches.length || (typed && findMatches(typed, p.misses).length);
    statusEl.textContent = !input.value.trim() ? 'Type a country first.' : some ? 'Pick a country from the list, or type its full name.' : "That isn't a country we know.";
    haptic.error();
    return;
  }
  if (p.misses.includes(code)) {
    statusEl.textContent = `You already tried ${nameOf(code)}.`;
    return;
  }
  input.value = '';
  if (code === mysteries[i].country) {
    p.solved = true;
    haptic.success();
    statusEl.textContent = '';
  } else {
    p.misses.push(code);
    haptic.error();
    const area = $('guess-area');
    area.classList.remove('is-wrong');
    void area.offsetWidth;
    area.classList.add('is-wrong');
    const left = MAX_MISSES - p.misses.length;
    if (left <= 0) p.failed = true;
    else statusEl.textContent = `Not ${nameOf(code)}. ${left} ${left === 1 ? 'guess' : 'guesses'} left.`;
  }
  persist();
  renderCard();
  if (finished(p)) {
    $('next').focus({ preventScroll: true });
    showFromTop(card);
  }
  else input.focus();
}

function useHint() {
  const p = state.passports[state.cursor];
  if (busy || state.done || finished(p) || p.hinted || hintsUsed() >= FREE_HINTS) return;
  haptic.tap();
  p.hinted = true;
  persist();
  renderHint();
}

async function next() {
  if (busy) return;
  haptic.tap();
  if (state.cursor >= ROUNDS - 1) {
    finish();
    return;
  }
  busy = true;
  if (!reducedMotion()) {
    card.classList.add('is-leaving');
    await new Promise((r) => setTimeout(r, 170));
    card.classList.remove('is-leaving');
  }
  state.cursor += 1;
  persist();
  busy = false;
  statusEl.textContent = '';
  renderCard();
  focusQuietly(card.querySelector('h2'));
  if (!reducedMotion()) {
    card.classList.add('is-entering');
    setTimeout(() => card.classList.remove('is-entering'), 360);
  }
  showFromTop(card);
}

function finish() {
  state.done = true;
  if (!state.counted) {
    state.counted = true;
    recordDay(STATS_KEY, today, score());
  }
  persist();
  render();
  focusQuietly($('result-title'));
  scrollToTop();
}

/* ---------- Result ---------- */
function renderResult() {
  $('result').hidden = !state.done;
  $('recap').hidden = !state.done;
  $('board').hidden = state.done;
  if (!state.done) return;
  showGrade('mystery-passport', (score() / MAX) * 100, todayKey);
  const s = score();
  const solved = state.passports.filter((p) => p.solved).length;
  $('result-title').textContent = s >= 240 ? 'Seasoned traveller.' : s >= 160 ? 'Well travelled.' : s >= 80 ? 'Good trip.' : 'Rough seas.';
  $('result-sub').textContent = `You identified ${solved} of ${ROUNDS} countries and scored ${s} out of ${MAX}.`;

  const st = readStats(STATS_KEY);
  const streak = st.lastDay >= today - 1 ? st.streak : 0;
  const rows: [string, string][] = [
    ['Played', String(st.played)],
    ['Average', st.played ? String(Math.round(st.total / st.played)) : '0'],
    ['Best', String(st.best)],
    ['Day streak', String(streak)],
  ];
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      d.append(dt, dd);
      return d;
    }),
  );
  $('recap-list').replaceChildren(
    ...mysteries.map((m, i) => {
      const p = state.passports[i];
      const sec = document.createElement('section');
      sec.className = 'recap-pass';
      const img = document.createElement('img');
      img.src = flag(m.country);
      img.alt = '';
      const h = document.createElement('h3');
      h.textContent = nameOf(m.country);
      const line = document.createElement('p');
      line.textContent = p.solved ? `Solved with ${p.opened.length} of 6 stamps` : 'Not solved';
      const pts = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `+${p.solved ? worth(p) : 0}`;
      pts.append(strong, document.createTextNode(' points'));
      sec.append(img, h, line, pts);
      return sec;
    }),
  );
  startCountdown();
}

function shareString(): string {
  const lines = state.passports.map((p) => {
    const stamps = ORDER.map((t) => (p.opened.includes(t) ? '■' : '□')).join('');
    return `${stamps}  ${p.solved ? `+${worth(p)}` : 'missed'}`;
  });
  const hints = hintsUsed() ? [`${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used`] : [];
  return [`Mystery Passport No. ${puzzleNo} · ${score()}/${MAX}`, ...lines, ...hints, `${location.origin}/games/mystery-passport`].join('\n');
}

let countdownTimer = 0;
function startCountdown() {
  const el = $('countdown');
  const tick = () => {
    const ms = msUntilTomorrow();
    // The day rollover itself is handled by watchDayChange; here we just stop at zero.
    const sec = Math.floor(ms / 1000);
    el.textContent = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  clearInterval(countdownTimer);
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function render() {
  if (!state.done) renderCard();
  else renderTrip();
  renderResult();
}

/* ---------- Events ---------- */
stampsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.stamp-slot');
  if (btn && !btn.disabled) unlock(btn.dataset.type as ClueType);
});
input.addEventListener('input', suggest);
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!matches.length) return;
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    navigated = true;
    drawList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    guess();
  } else if (e.key === 'Escape') {
    closeList();
  }
});
input.addEventListener('blur', () => setTimeout(closeList, 120));
// Keep focus in the input when pressing a suggestion, but only commit on a real click/tap
// (so starting to scroll the list on a phone never submits a guess).
listEl.addEventListener('pointerdown', (e) => e.preventDefault());
listEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-code]');
  if (!li) return;
  const m = matches.find((x) => x.code === li.dataset.code);
  if (!m) return;
  input.value = m.name;
  guess();
});
guessBtn.addEventListener('click', () => guess());
hintBtn.addEventListener('click', useHint);
$('next').addEventListener('click', () => void next());
$('share').addEventListener('click', async () => {
  haptic.tap();
  const res = await shareText(shareString());
  const msg = $('result-msg');
  msg.textContent = res === 'copied' ? 'Result copied. Paste it anywhere.' : res === 'failed' ? "Couldn't share from this browser." : '';
  setTimeout(() => (msg.textContent = ''), 2600);
});

/* ---------- Boot ---------- */
render();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('mystery-passport', STATE_KEY, todayKey);
