import { didKey } from './pipeline';
import type { SeriesKind } from './schemas/session';

// ------------------------------------------------------------ key mapping

/** Where a recorded series lands in the store history. */
export interface MappedSeries {
  key: string;
  /** DIDs take label, unit and range from defs; sensor/derived from the response. */
  fromDefs: boolean;
  group: string;
  label: string;
}

/**
 * did.<NAME> -> the live DID key (so the scope's DID channels and the cluster show the
 * recorded values); sensor.<x> -> "sensor:<x>"; derived.<x> -> "derived:<x>".
 */
export function mapSeriesKey(name: string, kind: SeriesKind): MappedSeries {
  const dot = name.indexOf('.');
  const rest = dot >= 0 ? name.slice(dot + 1) : name;
  if (kind === 'did') return { key: didKey(rest), fromDefs: true, group: 'vehicle DID', label: rest };
  if (kind === 'sensor') return { key: `sensor:${rest}`, fromDefs: false, group: 'session · sensor', label: rest };
  return { key: `derived:${rest}`, fromDefs: false, group: 'session · derived', label: rest };
}
