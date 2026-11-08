// TEST PHASE ONLY. While true, every game shows a "Reset today's game" button at the bottom so
// the owner can replay and test. Set to false before launch (the build prints a reminder).
import { remove } from './storage';
import { forgetResult, type GameId } from './grades';

export const TEST_MODE = false;

export function addTestReset(game: GameId, stateKey: string, todayKey: string) {
  if (!TEST_MODE) return;
  const main = document.getElementById('main');
  if (!main) return;
  const box = document.createElement('section');
  box.className = 'test-tools';
  box.setAttribute('aria-label', 'Test tools');
  const label = document.createElement('p');
  label.textContent = 'Test mode: replay today\'s puzzle from the start. Stats and streaks are not counted twice.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.textContent = "Reset today's game";
  btn.addEventListener('click', () => {
    remove(stateKey);
    forgetResult(game, todayKey);
    window.location.reload();
  });
  box.append(label, btn);
  main.append(box);
}
