// World land shapes, bundled locally from world-atlas (Natural Earth, public domain).
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, FeatureCollection, MultiPolygon } from 'geojson';
import land110 from 'world-atlas/land-110m.json';

let cached: Feature<MultiPolygon> | FeatureCollection | null = null;

export function getLand() {
  if (!cached) {
    const topo = land110 as unknown as Topology<{ land: GeometryCollection }>;
    cached = feature(topo, topo.objects.land) as FeatureCollection;
  }
  return cached;
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
