import '../../shared/base';
import '../../shared/game.css';
import './fof.css';
import { COUNTRIES } from '../../data/countries';
import { dayIndex, dayKey, msUntilTomorrow, seededRandom, shuffle } from '../../shared/daily';
import { load, save } from '../../shared/storage';
import { shareText } from '../../shared/share';
import { haptic } from '../../shared/haptics';
import { reducedMotion } from '../../shared/geo';
import { arrive, miniGlobe } from '../../shared/travel';
import { showGrade } from '../../shared/grades';
import { addTestReset } from '../../shared/testing';
import { watchDayChange, recordDay, readStats, focusQuietly, scrollToTop, showFromTop } from '../../shared/session';
import { loadToday, showLoadError } from '../../shared/bank';

/* ---------- Types & data ---------- */
interface Statement {
  text: string;
  fib?: boolean;
  truth?: string;
  sourceUrl: string;
}
interface Round {
  country: string;
  statements: Statement[];
}
type Bet = 'sure' | 'hunch';
interface Answer {
  pick: number; // index into the displayed order
  bet: Bet;
  correct: boolean;
  points: number;
}
interface State {
  answers: Answer[];
  fp?: string; // which puzzle this progress belongs to
  cursor: number; // round on screen (can lag answers by one while the reveal is showing)
  ruledOut: Record<number, number>; // round -> displayed index removed by a hint
  done: boolean;
  counted: boolean;
}

const ROUNDS = 5;
const FREE_HINTS = 3;
const POINTS: Record<Bet, [number, number]> = { sure: [2, -1], hunch: [1, 0] }; // [right, wrong]

const flagUrls = import.meta.glob('/node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const flag = (code: string) => flagUrls[`/node_modules/flag-icons/flags/4x3/${code}.svg`] ?? '';
const nameOf = (code: string) => COUNTRIES[code]?.name ?? code.toUpperCase();

const today = dayIndex();
const todayKey = dayKey(); // fixed before any await, so a slow load can't straddle midnight
const puzzleNo = today + 1;
const { rounds } = await loadToday<{ rounds: Round[] }>('fact-or-fib').catch((e) => {
  showLoadError(document.getElementById('board'));
  throw e;
});
// Same order for everyone today, different order per round, so the fib isn't always in one slot.
const order = rounds.map((r, i) => shuffle(r.statements.map((_, j) => j), seededRandom(today * 131 + i * 977 + 5)));
const shown = (round: number) => order[round].map((j) => rounds[round].statements[j]);
const fibIndex = (round: number) => shown(round).findIndex((s) => s.fib);

const STATE_KEY = `fact-or-fib:day:${todayKey}`;
const FP = rounds.map((r) => r.country).join();
const STATS_KEY = 'fact-or-fib:stats';

function sanitize(s: State | null): State {
  const fresh: State = { answers: [], cursor: 0, ruledOut: {}, done: false, counted: false, fp: FP };
  // Progress saved for a different puzzle (e.g. after the puzzle bank changes) is discarded.
  if (!s || typeof s !== 'object' || s.fp !== FP) return fresh;
  if (!Array.isArray(s.answers) || s.answers.length > ROUNDS || typeof s.ruledOut !== 'object' || s.ruledOut === null) return fresh;
  if (s.answers.some((a) => !a || typeof a !== 'object' || !Number.isInteger(a.pick) || a.pick < 0 || a.pick > 2 || (a.bet !== 'sure' && a.bet !== 'hunch'))) return fresh;
  // Never trust stored scores: work them out again from the pick and the bet.
  s.answers = s.answers.map((a, i) => {
    const correct = a.pick === fibIndex(i);
    return { pick: a.pick, bet: a.bet, correct, points: POINTS[a.bet][correct ? 0 : 1] };
  });
  // Hints only ever rule out a true statement, at most three times a day.
  const ruledOut: Record<number, number> = {};
  for (const [k, v] of Object.entries(s.ruledOut)) {
    const round = Number(k);
    if (Object.keys(ruledOut).length >= FREE_HINTS) break;
    if (Number.isInteger(round) && round >= 0 && round < ROUNDS && Number.isInteger(v) && v >= 0 && v < 3 && v !== fibIndex(round)) ruledOut[round] = v;
  }
  s.ruledOut = ruledOut;
  s.done = s.done === true && s.answers.length === ROUNDS;
  s.counted = s.counted === true;
  s.cursor = Math.min(Math.max(0, Number(s.cursor) | 0), ROUNDS - 1, s.answers.length);
  return s;
}
const state = sanitize(load<State | null>(STATE_KEY, null));
const persist = () => save(STATE_KEY, state);
const hintsUsed = () => Object.keys(state.ruledOut).length;
const score = () => state.answers.reduce((n, a) => n + a.points, 0);

/* ---------- Elements ---------- */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = $('card');
const claimsEl = $('claims');
const betEl = $('bet');
const afterEl = $('after');
const nextBtn = $<HTMLButtonElement>('next');
const hintBtn = $<HTMLButtonElement>('hint');
const scoreEl = $('score');
const mini = miniGlobe($('mini-globe'));
let pick: number | null = null;
let busy = false;

$('puzzle-meta').textContent = `No. ${puzzleNo} · ${new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
}).format(new Date())}`;

/* ---------- Rendering ---------- */
function renderTrip() {
  $('trip').replaceChildren(
    ...rounds.map((r, i) => {
      const li = document.createElement('li');
      const a = state.answers[i];
      if (a) {
        li.className = 'is-done';
        li.dataset.level = a.correct ? '1' : '4';
      }
      if (i === state.cursor && !state.done) li.classList.add('is-current');
      const stop = document.createElement('span');
      stop.className = 'stop';
      if (a || i === state.cursor) {
        const img = document.createElement('img');
        img.src = flag(r.country);
        img.alt = '';
        stop.append(img);
      } else {
        stop.textContent = String(i + 1);
      }
      const label = document.createElement('span');
      label.className = 'visually-hidden';
      label.textContent = a ? `${nameOf(r.country)}: ${a.correct ? 'correct' : 'missed'}` : i === state.cursor ? `Stop ${i + 1}, current` : `Stop ${i + 1}`;
      li.append(stop, label);
      return li;
    }),
  );
}

function renderHint() {
  const left = FREE_HINTS - hintsUsed();
  $('hint-count').textContent = String(left);
  hintBtn.setAttribute('aria-label', `Use a hint. ${left} of ${FREE_HINTS} left.`);
  const answered = state.answers.length > state.cursor;
  hintBtn.disabled = busy || state.done || answered || left <= 0 || state.cursor in state.ruledOut;
}

function renderCard() {
  const i = state.cursor;
  const r = rounds[i];
  const answer = state.answers[i];
  const flagImg = $<HTMLImageElement>('card-flag');
  flagImg.src = flag(r.country);
  $('card-step').textContent = `Stop ${i + 1} of ${ROUNDS}`;
  $('card-country').textContent = nameOf(r.country);
  scoreEl.textContent = String(score());
  $('prompt').textContent = answer ? (answer.correct ? 'You spotted the fib.' : 'The fib got past you.') : 'Which one is the fib?';

  const ruled = state.ruledOut[i];
  claimsEl.replaceChildren(
    ...shown(i).map((s, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'claim';
      btn.dataset.idx = String(idx);
      const letter = document.createElement('span');
      letter.className = 'claim-letter';
      letter.textContent = 'ABC'[idx];
      letter.setAttribute('aria-hidden', 'true');
      const body = document.createElement('span');
      body.className = 'claim-text';
      if (answer && s.fib) {
        const strike = document.createElement('s');
        strike.textContent = s.text;
        body.append(strike);
      } else {
        body.textContent = s.text;
      }

      if (answer) {
        btn.disabled = true;
        btn.classList.add('is-revealed', s.fib ? 'is-fib' : 'is-fact');
        if (idx === answer.pick) btn.setAttribute('aria-current', 'true');
        if (s.fib && s.truth) {
          const truth = document.createElement('span');
          truth.className = 'claim-truth';
          truth.textContent = s.truth;
          body.append(truth);
        }
        const src = document.createElement('a');
        src.className = 'claim-src';
        src.href = s.sourceUrl;
        src.target = '_blank';
        src.rel = 'noopener noreferrer';
        src.textContent = 'Source';
        src.setAttribute('aria-label', `Source for statement ${'ABC'[idx]}`);
        body.append(src);
        const stamp = document.createElement('span');
        stamp.className = 'stamp';
        stamp.textContent = s.fib ? 'Fib' : 'Fact';
        btn.append(stamp);
        if (idx === answer.pick) {
          btn.classList.add('is-mine');
          const mine = document.createElement('span');
          mine.className = 'claim-mine';
          mine.textContent = 'Your pick';
          body.prepend(mine);
        }
      } else if (ruled === idx) {
        btn.disabled = true;
        btn.classList.add('is-ruled-out');
        const note = document.createElement('span');
        note.className = 'claim-note';
        note.textContent = 'Ruled out by a hint: this one is true';
        body.append(note);
      } else {
        btn.setAttribute('aria-pressed', String(pick === idx));
      }
      btn.prepend(letter);
      btn.append(body);
      if (answer) {
        // Revealed statements contain a Source link, which must not sit inside a (disabled) button.
        const box = document.createElement('div');
        box.className = btn.className;
        box.append(...btn.childNodes);
        li.append(box);
        return li;
      }
      li.append(btn);
      return li;
    }),
  );

  betEl.hidden = !!answer || pick === null;
  afterEl.hidden = !answer;
  if (answer) {
    const v = $('verdict');
    v.replaceChildren(document.createTextNode(answer.correct ? (answer.bet === 'sure' ? 'Nailed it.' : 'Good hunch.') : answer.bet === 'sure' ? 'Confidently wrong.' : 'Not this time.'));
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.dataset.level = answer.points > 0 ? '1' : answer.points < 0 ? '4' : '3';
    pts.textContent = `${answer.points > 0 ? '+' : answer.points < 0 ? '−' : '±'}${Math.abs(answer.points)}`;
    v.append(pts);
    nextBtn.textContent = i === ROUNDS - 1 ? 'See your results' : 'Next country';
  }
  renderHint();
  renderTrip();
  syncMini();
}

function syncMini() {
  const dots = rounds.flatMap((r, i) => {
    const a = state.answers[i];
    if (!a && i !== state.cursor) return [];
    const c = COUNTRIES[r.country];
    return [{ lon: c.lon, lat: c.lat, level: a ? (a.correct ? 1 : 4) : 5 }];
  });
  mini.setDots(dots);
  if (!state.done) mini.focus([COUNTRIES[rounds[state.cursor].country]]);
}

/* ---------- Actions ---------- */
function choose(idx: number) {
  if (busy || state.done || state.answers[state.cursor] || state.ruledOut[state.cursor] === idx) return;
  pick = pick === idx ? null : idx;
  haptic.select();
  claimsEl.querySelectorAll<HTMLButtonElement>('.claim').forEach((b) => {
    if (!b.disabled) b.setAttribute('aria-pressed', String(Number(b.dataset.idx) === pick));
  });
  const wasHidden = betEl.hidden;
  betEl.hidden = pick === null;
  if (wasHidden && !betEl.hidden) revealAboveTabbar(betEl);
}

/** On a phone the bet buttons can land under the bottom tab bar; nudge them into view. */
function revealAboveTabbar(el: HTMLElement) {
  const bar = document.querySelector<HTMLElement>('.tabbar');
  const barTop = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top : window.innerHeight;
  const overflow = el.getBoundingClientRect().bottom - (barTop - 12);
  if (overflow > 0) window.scrollBy({ top: overflow, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function answer(bet: Bet) {
  if (busy || pick === null || state.answers[state.cursor]) return;
  const correct = pick === fibIndex(state.cursor);
  const points = POINTS[bet][correct ? 0 : 1];
  state.answers.push({ pick, bet, correct, points });
  pick = null;
  persist();
  if (correct) haptic.success();
  else haptic.error();
  renderCard();
  scoreEl.classList.remove('is-bump');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('is-bump');
  afterEl.querySelector('button')?.focus({ preventScroll: true });
  showFromTop(card);
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
  renderCard();
  focusQuietly(card.querySelector('h2'));
  if (!reducedMotion()) {
    card.classList.add('is-entering');
    setTimeout(() => card.classList.remove('is-entering'), 360);
  }
  busy = false;
  renderHint();
  showFromTop(card);
}

function useHint() {
  const i = state.cursor;
  if (busy || state.done || state.answers[i] || i in state.ruledOut || hintsUsed() >= FREE_HINTS) return;
  haptic.tap();
  // Rule out one of the two true statements (the same one for everyone today).
  const trues = shown(i)
    .map((s, idx) => ({ s, idx }))
    .filter((x) => !x.s.fib)
    .map((x) => x.idx);
  const out = trues[Math.floor(seededRandom(today * 31 + i)() * trues.length)];
  state.ruledOut[i] = out;
  if (pick === out) pick = null;
  const hadFocus = document.activeElement === hintBtn;
  persist();
  renderCard();
  // The hint button is disabled now; move keyboard focus to the first statement still in play.
  if (hadFocus) claimsEl.querySelector<HTMLButtonElement>('.claim:not(:disabled)')?.focus();
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
  const box = $('result');
  const recap = $('recap');
  box.hidden = !state.done;
  recap.hidden = !state.done;
  $('board').hidden = state.done;
  if (!state.done) return;
  // Spotting the fib matters most; confident bets add the rest. All five right on hunches is a B+.
  const spotted = state.answers.filter((a) => a.correct).length / ROUNDS;
  showGrade('fact-or-fib', 60 * spotted + 40 * (Math.max(0, score()) / (ROUNDS * 2)), todayKey);

  const s = score();
  const right = state.answers.filter((a) => a.correct).length;
  $('result-title').textContent = s >= 9 ? 'World-class.' : s >= 6 ? 'Well travelled.' : s >= 3 ? 'Good trip.' : 'Rough seas.';
  $('result-sub').textContent = `You spotted ${right} of ${ROUNDS} fibs and scored ${s} out of a possible 10.`;

  const st = readStats(STATS_KEY);
  const streak = st.lastDay >= today - 1 ? st.streak : 0;
  const rows: [string, string][] = [
    ['Played', String(st.played)],
    ['Average', st.played ? (st.total / st.played).toFixed(1) : '0'],
    ['Best', String(Math.max(0, st.best))],
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
    ...rounds.map((r, i) => {
      const a = state.answers[i];
      const fib = r.statements.find((x) => x.fib)!;
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = flag(r.country);
      img.alt = '';
      const body = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = nameOf(r.country);
      const lie = document.createElement('p');
      lie.className = 'recap-fib';
      lie.append(hidden('The fib: '), fib.text);
      const truth = document.createElement('p');
      if (fib.truth) truth.append(hidden('The truth: '), fib.truth);
      const src = document.createElement('a');
      src.href = fib.sourceUrl;
      src.target = '_blank';
      src.rel = 'noopener noreferrer';
      src.textContent = 'Source';
      src.setAttribute('aria-label', `Source for the ${nameOf(r.country)} fib`);
      body.append(name, lie, truth, src);
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.dataset.level = a && a.points > 0 ? '1' : a && a.points < 0 ? '4' : '3';
      pts.textContent = a ? `${a.points > 0 ? '+' : a.points < 0 ? '−' : '±'}${Math.abs(a.points)}` : '–';
      li.append(img, body, pts);
      return li;
    }),
  );
  startCountdown();
}

/** Text only screen readers hear (the strikethrough and colours carry it visually). */
function hidden(text: string) {
  const span = document.createElement('span');
  span.className = 'visually-hidden';
  span.textContent = text;
  return span;
}

function shareString(): string {
  // Plain text marks, not emoji: a tick or cross per country, with the points that bet earned.
  const dots = state.answers.map((a) => `${a.correct ? '✓' : '✗'}${a.points > 0 ? '+' : a.points < 0 ? '−' : ''}${Math.abs(a.points)}`).join(' ');
  const hints = hintsUsed() ? `\n${hintsUsed()} ${hintsUsed() === 1 ? 'hint' : 'hints'} used` : '';
  return `Fact or Fib No. ${puzzleNo} · ${score()}/10\n${dots}${hints}\n${location.origin}/games/fact-or-fib`;
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
  else {
    renderTrip();
    syncMini();
  }
  renderResult();
}

/* ---------- Events ---------- */
claimsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.claim');
  if (btn && !btn.disabled) choose(Number(btn.dataset.idx));
});
betEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bet-btn');
  if (btn) answer(btn.dataset.bet as Bet);
});
nextBtn.addEventListener('click', () => void next());
hintBtn.addEventListener('click', useHint);
let shareMsgTimer = 0;
$('share').addEventListener('click', async () => {
  haptic.tap();
  const res = await shareText(shareString());
  const msg = $('result-msg');
  msg.textContent = res === 'copied' ? 'Result copied. Paste it anywhere.' : res === 'failed' ? "Couldn't share from this browser." : '';
  clearTimeout(shareMsgTimer);
  shareMsgTimer = window.setTimeout(() => (msg.textContent = ''), 2600);
});
// Keyboard: A/B/C or 1/2/3 to pick a statement.
card.addEventListener('keydown', (e) => {
  // Shortcuts only while focus is inside the game card (WCAG 2.1.4: no page-wide single-key shortcuts).
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, a')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : '';
  const idx = key ? Math.max('abc'.indexOf(key), '123'.indexOf(key)) : -1;
  if (idx >= 0 && !state.done) choose(idx);
});

/* ---------- Boot ---------- */
render();
void arrive(mini, $('mini-globe'));
watchDayChange(todayKey);
addTestReset('fact-or-fib', STATE_KEY, todayKey);
