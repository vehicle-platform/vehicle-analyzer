import platformDbc from '@defs/dbc/platform.dbc?raw';
import vehicleDbc from '@defs/dbc/cl250.dbc?raw';
import vehicleYaml from '@defs/uds/vehicle_cl250.yaml?raw';
import obdCatalogYaml from '@defs/uds/obd_catalog.yaml?raw';
import iso14229Yaml from '@defs/uds/iso14229.yaml?raw';
import derivedYaml from '@defs/derived/cl250_derived.yaml?raw';
import limitsYaml from '@defs/limits/platform_limits.yaml?raw';
import { buildDefs, Defs } from './model';

export * from './model';

/** The pinned vehicle-defs copy, bundled at build time (git submodule at a tag). */
export const DEFS: Defs = buildDefs({
  ref: __DEFS_REF__,
  platformDbc,
  vehicleDbc,
  vehicleYaml,
  obdCatalogYaml,
  iso14229Yaml,
  derivedYaml,
  limitsYaml,
});
