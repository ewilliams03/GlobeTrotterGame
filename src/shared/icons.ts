// Small hand-drawn line icons (24px grid, 2px stroke, currentColor). Used instead of emoji
// so every icon matches the site's style in both themes.
const NS = 'http://www.w3.org/2000/svg';

const ICONS: Record<string, { d: string[]; circles?: [number, number, number][] }> = {
  mountain: { d: ['M2.5 19.5 9 8.5l4.2 6.8 2.3-3.3 6 7.5Z', 'M7.4 11.2 9 13l1.4-1.6'] },
  area: { d: ['M4.5 4.5h15v15h-15Z', 'M4.5 9h2.5M4.5 13.5h2.5M9 4.5V7M13.5 4.5V7'] },
  borders: { d: ['M3 6.5 8.5 5l3.5 2.5v12L6.5 21 3 18.5Z', 'M12 7.5 17.5 6 21 8.5v10l-5.5 1.5-3.5-2'] },
  north: { d: ['M12 20V4', 'M6.5 9.5 12 4l5.5 5.5'] },
  south: { d: ['M12 4v16', 'M6.5 14.5 12 20l5.5-5.5'] },
  coast: { d: ['M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0', 'M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0', 'M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0'] },
  leaf: { d: ['M5 19C5 10.5 10.5 5 19 5c0 8.5-5.5 14-14 14Z', 'M5 19l7.5-7.5'] },
  bowl: { d: ['M3 11.5h18a9 9 0 0 1-18 0Z', 'M9 8c0-1.6 1.5-1.8 1.5-3.5M13.5 8c0-1.6 1.5-1.8 1.5-3.5'] },
  speech: { d: ['M4 5h16v11H10l-5 4v-4H4Z', 'M8 9.5h8M8 12.5h5'] },
  coin: {
    d: ['M14.6 9.4c-.5-.9-1.5-1.4-2.6-1.4-1.7 0-2.9.9-2.9 2s1.2 1.6 2.9 2 2.9.9 2.9 2-1.2 2-2.9 2c-1.1 0-2.1-.5-2.6-1.4', 'M12 6.3v1.7M12 16v1.7'],
    circles: [[12, 12, 9]],
  },
  columns: { d: ['M3 9 12 4l9 5Z', 'M5.5 9v8.5M10 9v8.5M14 9v8.5M18.5 9v8.5', 'M3 20h18'] },
  compass: { d: ['M15.5 8.5l-2 5-5 2 2-5Z'], circles: [[12, 12, 9]] },
  home: { d: ['M4 11.5 12 4.5l8 7', 'M6.5 9.5V19.5h11V9.5', 'M10 19.5v-5h4v5'] },
  report: { d: ['M5.5 4.5h13v15h-13Z', 'M9 9h6M9 12.5h6M9 16h3.5'] },
  info: { d: ['M12 11v5.5', 'M12 7.6v.1'], circles: [[12, 12, 9]] },
  pin: { d: ['M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z'], circles: [[12, 10, 2.3]] },
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const spec = ICONS[name] ?? ICONS.compass;
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of spec.d) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  for (const [cx, cy, r] of spec.circles ?? []) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    svg.append(c);
  }
  return svg;
}
