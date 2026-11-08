import { geoEqualEarth, geoPath, geoGraticule10 } from 'd3-geo';
import type { LineString } from 'geojson';
import { getLand, reducedMotion } from '../../shared/geo';
import { COUNTRIES } from '../../data/countries';

const NS = 'http://www.w3.org/2000/svg';
const W = 960;
const H = 470;

export interface MapGroup {
  level: number;
  countries: string[];
  label: string;
}

export function createAtlas(svg: SVGSVGElement) {
  const projection = geoEqualEarth().fitExtent(
    [
      [8, 8],
      [W - 8, H - 8],
    ],
    { type: 'Sphere' },
  );
  const path = geoPath(projection);

  const add = (parent: Element, tag: string, attrs: Record<string, string>) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.appendChild(node);
    return node;
  };

  add(svg, 'path', { class: 'map-grat', d: path(geoGraticule10()) ?? '' });
  add(svg, 'path', { class: 'map-land', d: path(getLand()) ?? '' });
  const layer = add(svg, 'g', {});
  const drawn = new Set<string>();

  function show(group: MapGroup, animate: boolean) {
    const key = group.countries.join();
    if (drawn.has(key)) return;
    drawn.add(key);

    // Order the stops west to east so the route reads like a journey.
    const stops = group.countries
      .map((c) => ({ code: c, ...COUNTRIES[c] }))
      .sort((a, b) => a.lon - b.lon);
    const line: LineString = { type: 'LineString', coordinates: stops.map((s) => [s.lon, s.lat]) };
    const g = add(layer, 'g', { 'data-level': String(group.level) });
    const glow = add(g, 'path', { class: 'map-link-glow', d: path(line) ?? '' }) as SVGPathElement;
    const link = add(g, 'path', { class: 'map-link', d: path(line) ?? '' }) as SVGPathElement;

    stops.forEach((s, i) => {
      const xy = projection([s.lon, s.lat]);
      if (!xy) return;
      const dot = add(g, 'circle', { class: 'map-stop', cx: xy[0].toFixed(1), cy: xy[1].toFixed(1), r: '6' }) as SVGCircleElement;
      if (animate) dot.style.animationDelay = `${180 + i * 140}ms`;
      const title = document.createElementNS(NS, 'title');
      title.textContent = s.name;
      dot.appendChild(title);
    });

    if (animate && !reducedMotion()) {
      const len = link.getTotalLength();
      for (const p of [glow, link]) {
        p.style.strokeDasharray = `${len}`;
        p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
          duration: 900,
          easing: 'cubic-bezier(0.77, 0, 0.175, 1)',
          fill: 'backwards',
        }).finished.then(() => (p.style.strokeDasharray = ''), () => {});
      }
    }
  }

  return { show };
}
