import React, { useEffect, useRef, useState } from 'react';
import { Segmented, Status, TermButton, cn, type StatusLevel } from '../ui/primitives';
import { Empty, TH, TD } from '../ui/panel-parts';
import {
  BRINGUP_GATES,
  BringupUnsupportedError,
  type BringupGate,
  type BringupResult,
  type BringupStatus,
  fetchBringup,
  formatBringupMeasured,
} from '../services/sessionClient';

interface BringupCheckProps {
  token: string;
  serverUrl: string;
  sessionId: string | null;
}

type BringupState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; result: BringupResult };

/** Same status tokens as the rest of the analyzer: manual = quiet (neutral), unknown = faint. */
const LEVEL: Record<BringupStatus, { level: StatusLevel; quiet?: boolean }> = {
  pass: { level: 'ok' },
  fail: { level: 'fault' },
  warn: { level: 'warn' },
  manual: { level: 'ok', quiet: true },
  unknown: { level: 'na' },
};

interface BringupBodyProps {
  token: string;
  serverUrl: string;
  sessionId: string;
  gate: BringupGate;
  onRetry: () => void;
}

/** One session/gate request; remounted by key when the request changes, so its state starts at loading. */
const BringupBody: React.FC<BringupBodyProps> = ({ token, serverUrl, sessionId, gate, onRetry }) => {
  const [state, setState] = useState<BringupState>({ kind: 'loading' });
  const connection = useRef({ serverUrl, token });
  useEffect(() => {
    connection.current = { serverUrl, token };
  }, [serverUrl, token]);

  useEffect(() => {
    let cancelled = false;
    fetchBringup({ serverUrl: connection.current.serverUrl, token: connection.current.token }, sessionId, gate)
      .then((result) => {
        if (!cancelled) setState({ kind: 'loaded', result });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState(error instanceof BringupUnsupportedError ? { kind: 'unsupported' } : { kind: 'error', message: error instanceof Error ? error.message : 'Request failed.' });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, gate]);

  if (state.kind === 'unsupported') return <Empty>this server has no bring-up check (needs vehicle-server with LR12)</Empty>;
  if (state.kind === 'error') {
    return (
      <div className="px-[14px] py-2">
        <div role="alert" className="text-term-red">
          ■ {state.message}
        </div>
        <TermButton className="mt-1" onClick={onRetry}>
          Retry
        </TermButton>
      </div>
    );
  }
  if (state.kind !== 'loaded' || state.result.sessionId !== sessionId || state.result.gate !== gate) return <Empty>Loading bring-up check...</Empty>;

  const { result } = state;
  const pending = result.needsYou.length;
  return (
    <div>
      <div className="flex flex-wrap gap-x-[2ch] px-[14px] py-1" aria-label="Bring-up verdict">
        <Status level={result.verdict === 'pass' ? 'ok' : result.verdict === 'fail' ? 'fault' : 'warn'}>
          {result.gate} {result.verdict}
        </Status>
        {pending > 0 && <span className="text-term-dim">{`${pending} manual check${pending === 1 ? '' : 's'} pending`}</span>}
        {result.warnings.length > 0 && <span className="text-term-amber">{`${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`}</span>}
      </div>
      {result.checks.length === 0 ? (
        <Empty>The server returned no checks for this gate.</Empty>
      ) : (
        <table className="w-full border-collapse" aria-label="Bring-up checks">
          <thead>
            <tr>
              <th className={TH}>status</th>
              <th className={TH}>check</th>
              <th className={TH}>measured</th>
              <th className={TH}>expected</th>
              <th className={TH}>source</th>
            </tr>
          </thead>
          <tbody>
            {result.checks.map((check) => (
              <tr key={check.id} title={check.note || undefined}>
                <td className={TD}>
                  <Status {...LEVEL[check.status]}>{check.status}</Status>
                </td>
                <td className={cn(TD, 'text-term-fg')}>
                  <div>{check.id}</div>
                  {check.note && <div className="text-term-faint">{check.note}</div>}
                </td>
                <td className={cn(TD, 'text-term-hi')}>{formatBringupMeasured(check.measured)}</td>
                <td className={cn(TD, 'text-term-dim')}>{check.expected}</td>
                <td className={cn(TD, 'text-term-faint')}>{check.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/** Server-side bring-up gate check of the selected session (LR12); everything shown is the server's answer. */
export const BringupCheck: React.FC<BringupCheckProps> = ({ token, serverUrl, sessionId }) => {
  const [gate, setGate] = useState<BringupGate>('V0');
  const [nonce, setNonce] = useState(0);
  const hasServer = serverUrl.trim() !== '';

  let body: React.ReactNode;
  if (!sessionId) body = <Empty>No recorded session selected.</Empty>;
  else if (!hasServer) body = <Empty>No vehicle-server URL configured.</Empty>;
  else
    body = (
      <BringupBody
        key={`${sessionId}:${gate}:${nonce}`}
        token={token}
        serverUrl={serverUrl}
        sessionId={sessionId}
        gate={gate}
        onRetry={() => setNonce((value) => value + 1)}
      />
    );

  return (
    <div>
      <div className="flex items-center gap-1 px-[14px] py-1">
        <Segmented<BringupGate> label="Bring-up gate" value={gate} onChange={setGate} options={BRINGUP_GATES.map((g) => ({ value: g, label: g }))} />
      </div>
      {body}
    </div>
  );
};
