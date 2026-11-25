import { cycleWeather, setWeather, getWeather, onWeatherEvent } from '../world/weather.js';

// HUD weather button (cycles Sunny > Cloudy > Rain > Storm > Auto) and the title-screen chooser.
const ICONS = {
  sunny: '<circle cx="12" cy="12" r="4.6"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3M4.8 4.8l2.1 2.1M17.1 17.1l2.1 2.1M4.8 19.2l2.1-2.1M17.1 6.9l2.1-2.1" stroke="#cfe3ff" stroke-width="2" stroke-linecap="round" fill="none"/>',
  cloudy: '<path d="M7 18.5a4.3 4.3 0 0 1-.6-8.55A5.8 5.8 0 0 1 17.4 8.6 4.95 4.95 0 0 1 17.5 18.5z"/>',
  rain: '<path d="M7 14a4.2 4.2 0 0 1-.5-8.4A5.6 5.6 0 0 1 17.2 4.4 4.7 4.7 0 0 1 17.5 14z"/><path d="M8 16.5l-1.2 3M12.5 16.5l-1.2 3M17 16.5l-1.2 3" stroke="#8fc0ff" stroke-width="2" stroke-linecap="round" fill="none"/>',
  storm: '<path d="M7 13.5a4.2 4.2 0 0 1-.5-8.4A5.6 5.6 0 0 1 17.2 3.9 4.7 4.7 0 0 1 17.5 13.5z"/><path d="M12.8 12.5l-3.3 5h2.6l-1.3 4.8 4.4-6.2h-2.7z" fill="#ffd75a"/>',
};
const LABEL = { sunny: 'Sunny', cloudy: 'Cloudy', rain: 'Rain', storm: 'Storm', windy: 'Windy', auto: 'Auto' };

export function initWeatherUI() {
  const btn = document.getElementById('wxBtn'), icon = document.getElementById('wxIcon'), label = document.getElementById('wxLabel');
  const chips = document.querySelectorAll('#wxPick button');
  const paint = () => {
    const w = getWeather();
    const mode = w.auto ? 'auto' : w.target;
    if (label) label.textContent = LABEL[mode] || mode;
    // icon always shows the weather that is actually happening (in Auto it follows the cycle)
    if (icon) icon.innerHTML = ICONS[w.target === 'windy' ? 'sunny' : w.target] || ICONS.sunny;
    if (btn) btn.classList.toggle('wet', w.target === 'rain' || w.target === 'storm');
    chips.forEach((c) => c.classList.toggle('on', c.dataset.wx === mode));
  };
  if (btn) btn.addEventListener('click', () => { cycleWeather(8); paint(); });
  chips.forEach((c) => c.addEventListener('click', () => { setWeather(c.dataset.wx, 6); paint(); }));
  onWeatherEvent((e) => { if (e.type === 'weather') paint(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'w' || e.key === 'W') { cycleWeather(8); paint(); } });
  paint();
}
