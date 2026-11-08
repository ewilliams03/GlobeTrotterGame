import './shared/base';
import { clearAll } from './shared/storage';

const btn = document.getElementById('clear-data');
const msg = document.getElementById('clear-msg');
btn?.addEventListener('click', () => {
  clearAll();
  if (msg) msg.textContent = 'Done. Your game data on this device has been deleted.';
});
