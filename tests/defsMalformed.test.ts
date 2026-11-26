import { describe, it, expect } from 'vitest';
import { buildDefs, type DefsSources } from '@/defs/model';
import platformDbc from '@defs/dbc/platform.dbc?raw';
import vehicleDbc from '@defs/dbc/cl250.dbc?raw';
import vehicleYaml from '@defs/uds/vehicle_cl250.yaml?raw';
import obdCatalogYaml from '@defs/uds/obd_catalog.yaml?raw';
import iso14229Yaml from '@defs/uds/iso14229.yaml?raw';
import derivedYaml from '@defs/derived/cl250_derived.yaml?raw';
import limitsYaml from '@defs/limits/platform_limits.yaml?raw';

const good: DefsSources = { ref: 'test', platformDbc, vehicleDbc, vehicleYaml, obdCatalogYaml, iso14229Yaml, derivedYaml, limitsYaml };

describe('buildDefs rejects malformed defs text', () => {
  it('accepts the pinned defs', () => {
    expect(() => buildDefs(good)).not.toThrow();
  });

  it.each([
    ['vehicleYaml', 'a scalar document'],
    ['vehicleYaml', '[1, 2]'],
    ['vehicleYaml', 'vehicle: x\nbus: 5\n'],
    ['obdCatalogYaml', 'null'],
    ['iso14229Yaml', 'services: {}\n'],
    ['derivedYaml', '42'],
    ['limitsYaml', '{}'],
  ] as const)('throws a defs error for %s = %s', (key, body) => {
    expect(() => buildDefs({ ...good, [key]: body })).toThrow(/defs:/);
  });
});
