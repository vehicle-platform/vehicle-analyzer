import React from 'react';
import { CaptureStore } from '../state/captureStore';
import { frameKey } from '../services/capture';
import { formatSignal, hexId } from '../services/format';
import { isE2EValid } from '../services/e2e';
import { CanFrame, DbcMessageDef } from '../types/can';
import { KeyValues, Na, Note, Pane, Status } from '../ui/primitives';

interface AttitudeGaugeProps {
  store: CaptureStore;
}

/** Latest frame of a platform message, if it is fresh (within 3 cycles) and its E2E check passed. */
function usable(store: CaptureStore, msg: DbcMessageDef | undefined): CanFrame | undefined {
  if (!msg) return undefined;
  const f = store.framesByKey.get(frameKey('platform', msg.id));
  if (!f) return undefined;
  if (msg.cycleTimeMs && (store.lastTime - f.timestamp) * 1000 > 3 * msg.cycleTimeMs) return undefined;
  if (msg.e2e && (!f.e2e || !isE2EValid(f.e2e))) return undefined;
  return f;
}

/* Arc scale geometry: centre at the bottom, ±60° in 15° steps. */
const CX = 75;
const CY = 88;
const R = 64;
const SCALE_DEG = 60;
const polar = (deg: number, r: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
};
const TICKS = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
const LABELS = [-60, -30, 0, 30, 60];

const LeanScale: React.FC<{ lean: number | null }> = ({ lean }) => {
  const a0 = polar(-SCALE_DEG, R);
  const a1 = polar(SCALE_DEG, R);
  const needle = lean === null ? null : polar(Math.max(-SCALE_DEG, Math.min(SCALE_DEG, lean)), R - 4);
  return (
    <svg width="150" height="94" viewBox="0 0 150 94" role="img" aria-label={lean === null ? 'Lean not available' : `Lean ${lean.toFixed(1)} degrees`}>
      <path d={`M ${a0.x} ${a0.y} A ${R} ${R} 0 0 1 ${a1.x} ${a1.y}`} fill="none" className="stroke-term-ruleHi" />
      <g className="stroke-term-faint">
        {TICKS.map((d) => {
          const p = polar(d, R);
          const q = polar(d, d === 0 ? R + 7 : R + 5);
          return <line key={d} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
        })}
      </g>
      <g className="fill-term-faint" fontSize="10" textAnchor="middle" fontFamily="inherit">
        {LABELS.map((d) => {
          const p = polar(d, R + 15);
          return (
            <text key={d} x={p.x} y={p.y + 3}>
              {Math.abs(d)}
            </text>
          );
        })}
      </g>
      <line x1="14" y1={CY} x2="136" y2={CY} className="stroke-term-rule" />
      <line x1={CX} y1={CY} x2={CX} y2="30" className="stroke-term-rule" strokeDasharray="2 3" />
      {needle && (
        <>
          <line x1={CX} y1={CY} x2={needle.x} y2={needle.y} className="stroke-term-hi" strokeWidth="1.5" />
          <rect x={CX - 2} y={CY - 2} width="4" height="4" className="fill-term-hi" />
        </>
      )}
    </svg>
  );
};

/** Cornering level as the safety partition sent it: GREEN plain, YELLOW amber `!`, RED red `■`, else faint. */
const Level: React.FC<{ level: string; source: string }> = ({ level, source }) => {
  const title = `source ${source}`;
  if (level === 'GREEN') return <Status level="ok" title={title}>GREEN</Status>;
  if (level === 'YELLOW') return <Status level="warn" title={title}>YELLOW</Status>;
  if (level === 'RED') return <Status level="fault" title={title}>RED</Status>;
  return <Status level="na" title={title}>{level}</Status>;
};

const idOf = (m: DbcMessageDef | undefined) => (m ? hexId(m.id, !!m.isExtended) : '–');

/**
 * Lean angle from rt-core's EKF (EkfLean) and the cornering warning level the safety
 * partition itself decided (SafetyWarningStatus). The colour is the partition's level,
 * never a threshold of the analyzer; a missing, stale or E2E-invalid status shows
 * UNAVAILABLE, never GREEN (platform.dbc comment on message 0x023).
 */
export const AttitudeGauge: React.FC<AttitudeGaugeProps> = ({ store }) => {
  const catalog = store.pipeline.catalog('platform');
  const leanMsg = catalog.find((m) => m.name === 'EkfLean');
  const warnMsg = catalog.find((m) => m.name === 'SafetyWarningStatus');
  const leanFrame = usable(store, leanMsg);
  const warnFrame = usable(store, warnMsg);
  const sig = (m: DbcMessageDef | undefined, n: string) => m?.signals.find((s) => s.name === n);

  const leanState = leanFrame ? formatSignal(sig(leanMsg, 'LEAN_ANGLE_STATE'), leanFrame.decodedSignals?.LEAN_ANGLE_STATE) : 'NO DATA';
  const leanUsable = leanFrame && (leanState === 'ESTIMATED' || leanState === 'CLAMPED');
  const lean = leanUsable ? Number(leanFrame.decodedSignals?.LEAN_ANGLE ?? 0) : null;
  const quality = leanFrame?.decodedSignals?.LEAN_ANGLE_QUALITY;

  const level = warnFrame ? formatSignal(sig(warnMsg, 'CORNERING_LEVEL'), warnFrame.decodedSignals?.CORNERING_LEVEL) : 'UNAVAILABLE';
  const source = warnFrame ? formatSignal(sig(warnMsg, 'CORNERING_SOURCE'), warnFrame.decodedSignals?.CORNERING_SOURCE) : '–';
  const bsmL = warnFrame ? formatSignal(sig(warnMsg, 'BSM_LEFT'), warnFrame.decodedSignals?.BSM_LEFT) : '–';
  const bsmR = warnFrame ? formatSignal(sig(warnMsg, 'BSM_RIGHT'), warnFrame.decodedSignals?.BSM_RIGHT) : '–';
  const immo = warnFrame ? formatSignal(sig(warnMsg, 'IMMOBILIZER_STATE'), warnFrame.decodedSignals?.IMMOBILIZER_STATE) : '–';

  const side = lean === null ? '' : lean > 0 ? ', right' : lean < 0 ? ', left' : '';
  const shown = lean === null ? null : Math.abs(lean).toFixed(1);
  const sign = lean === null ? '' : lean > 0 ? '+' : lean < 0 ? '−' : '';
  const dash = (v: string) => (v === '–' ? <Na /> : v);

  return (
    <Pane title="Lean & cornering" aside={`${idOf(leanMsg)} + ${idOf(warnMsg)}`} className="select-none">
      <div className="mb-2 grid grid-cols-[150px_1fr] items-end gap-x-3 gap-y-1">
        <LeanScale lean={lean} />
        <div>
          <div className="text-term-dim">lean{side}</div>
          {shown === null ? (
            <div className="text-big text-term-faint">–</div>
          ) : (
            <div className="text-big tracking-[-.02em] text-term-hi">
              <span className="text-term-dim">{sign}</span>
              {shown}
              <small className="ml-[2px] text-[22px] text-term-dim">°</small>
            </div>
          )}
        </div>
      </div>
      <KeyValues
        rows={[
          ['state', leanUsable ? leanState : leanFrame ? <Status level="warn">{leanState}</Status> : <Status level="na">{leanState}</Status>],
          ['quality', quality !== undefined ? `${quality} %` : <Na />],
          [
            'blind spot L / R',
            <>
              {dash(bsmL)} / {dash(bsmR)}
            </>,
          ],
          ['immobilizer', dash(immo)],
          ['cornering level', <Level level={level} source={source} />],
        ]}
      />
      <Note>Level comes from the safety partition ({idOf(warnMsg)}). The analyzer does not compute it.</Note>
    </Pane>
  );
};
