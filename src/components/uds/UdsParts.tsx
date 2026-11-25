import React from 'react';
import { DtcEntry, UdsTransaction } from '../../services/udsMonitor';
import { Defs } from '../../defs/model';
import { decodeDtcExtDataRecords, decodeDtcSnapshotRecords, DtcExtDataKind, DtcSnapshotValue, DtcStop } from '../../services/dtcRecords';
import { formatValue } from '../../services/format';
import { Na } from '../../ui/primitives';
import { hex2, hexBytes } from './hex';

/** Transaction status as text: ok dim, nrc red, pending amber, no response red, suppressed faint. */
export const StatusText: React.FC<{ t: UdsTransaction; nrcName: (n: number) => string | undefined }> = ({ t, nrcName }) => {
  switch (t.status) {
    case 'positive':
      return <span className="text-term-dim">ok</span>;
    case 'negative':
      return (
        <span className="text-term-red" title={t.nrc !== undefined ? nrcName(t.nrc) : undefined}>
          nrc{t.nrc !== undefined ? ` 0x${hex2(t.nrc)} ${nrcName(t.nrc) ?? ''}` : ''}
        </span>
      );
    case 'pending':
      return <span className="text-term-amber">…</span>;
    case 'no_response':
      return <span className="text-term-red">no response</span>;
    case 'suppressed':
      return <span className="text-term-faint">suppressed</span>;
  }
};

const STOP_LABEL: Record<DtcStop, string> = {
  unknown_did: 'unknown DID',
  variable_length: 'variable-length DID',
  truncated: 'truncated record',
};

const EXT_KIND_LABEL: Record<DtcExtDataKind, string> = {
  manufacturer: 'manufacturer-specific',
  obd: 'OBD',
  reserved: 'reserved',
};

export const DtcRecordCell: React.FC<{ defs: Defs; entry: DtcEntry }> = ({ defs, entry }) => {
  if (!entry.snapshot && !entry.extData) return <Na />;
  return (
    <>
      {entry.snapshot && <DtcSnapshotCard defs={defs} bytes={entry.snapshot} />}
      {entry.extData && <DtcExtDataCard defs={defs} bytes={entry.extData} />}
    </>
  );
};

const DtcValueText: React.FC<{ defs: Defs; value: DtcSnapshotValue }> = ({ defs, value }) => {
  const def = defs.catalogByDid.get(value.did);
  if (value.value !== null && typeof value.value === 'object') {
    return (
      <>
        {Object.entries(value.value).map(([name, fieldValue], i) => {
          const field = def?.fields?.find((f) => f.name === name);
          return (
            <span key={name}>
              {i > 0 && <span className="text-term-faint"> · </span>}
              <span className="text-term-faint">{name}</span>=<span className="text-term-hi">{formatValue(fieldValue)}</span>
              {field?.unit && <span className="text-term-dim"> {field.unit}</span>}
            </span>
          );
        })}
      </>
    );
  }
  return (
    <>
      <span className="text-term-hi">{formatValue(value.value)}</span>
      {def?.unit && <span className="text-term-dim"> {def.unit}</span>}
    </>
  );
};

const DtcSnapshotCard: React.FC<{ defs: Defs; bytes: number[] }> = ({ defs, bytes }) => {
  const decoded = decodeDtcSnapshotRecords(defs, bytes);
  const count = decoded.records.reduce((n, record) => n + record.values.length, 0);
  return (
    <div className="mb-1 border border-term-rule bg-term-raise px-2 py-1">
      <div className="text-term-hi">
        snapshot · {decoded.records.length} record{decoded.records.length === 1 ? '' : 's'} · {count} value{count === 1 ? '' : 's'}
      </div>
      {decoded.records.map((record, i) => (
        <div key={`${record.recordNumber}-${i}`} className="mt-1 border-l border-term-rule pl-2">
          <div className="text-term-faint">
            record {record.recordNumber} ·{' '}
            {record.numberOfIdentifiers === defs.iso.dtcRecordReports.snapshot.undefinedNumberOfIdentifiers
              ? 'identifiers run to the end'
              : `${record.numberOfIdentifiers} identifier${record.numberOfIdentifiers === 1 ? '' : 's'}`}
          </div>
          {record.values.map((value, j) => (
            <div key={`${value.did}-${j}`}>
              <span className="text-term-dim">{value.name}</span> (<span className="text-term-faint">0x{value.did.toString(16).toUpperCase().padStart(4, '0')}</span>) ={' '}
              <DtcValueText defs={defs} value={value} />
              <span className="ml-2 text-term-faint">{hexBytes(value.data)}</span>
            </div>
          ))}
        </div>
      ))}
      {decoded.stop && (
        <div className="mt-1 text-term-amber">
          ■ stopped at {STOP_LABEL[decoded.stop]}
          {decoded.rest.length > 0 && <span className="text-term-faint"> · rest {hexBytes(decoded.rest)}</span>}
        </div>
      )}
      {decoded.records.length === 0 && !decoded.stop && <div className="text-term-faint">no record stored</div>}
      <div className="mt-1 text-term-faint">raw {hexBytes(bytes)}</div>
    </div>
  );
};

const DtcExtDataCard: React.FC<{ defs: Defs; bytes: number[] }> = ({ defs, bytes }) => {
  const decoded = decodeDtcExtDataRecords(defs, bytes);
  return (
    <div className="mb-1 border border-term-rule bg-term-raise px-2 py-1">
      <div className="text-term-hi">
        extended data ·{' '}
        {decoded.firstRecordKind === null
          ? 'no record stored'
          : `record ${decoded.firstRecordNumber ?? '-'} (${EXT_KIND_LABEL[decoded.firstRecordKind]})`}
      </div>
      <div className="mt-1 text-term-faint">raw {hexBytes(bytes)}</div>
    </div>
  );
};
