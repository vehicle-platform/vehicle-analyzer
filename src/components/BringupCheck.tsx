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
  | { kind: 'idle' }
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

/** Server-side bring-up gate check of the selected session (LR12); everything shown is the server's answer. */
export const BringupCheck: React.FC<BringupCheckProps> = ({ token, serverUrl, sessionId }) => {
  const [gate, setGate] = useState<BringupGate>('V0');
  const [state, setState] = useState<BringupState>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const connection = useRef({ serverUrl, token });
  connection.current = { serverUrl, token };
  const hasServer = serverUrl.trim() !== '';

  useEffect(() => {
    if (!sessionId || !hasServer) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
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
  }, [sessionId, gate, hasServer, nonce]);

  let body: React.ReactNode;
  if (!sessionId) body = <Empty>No recorded session selected.</Empty>;
  else if (!hasServer) body = <Empty>No vehicle-server URL configured.</Empty>;
  else if (state.kind === 'idle' || state.kind === 'loading') body = <Empty>Loading bring-up check...</Empty>;
  else if (state.kind === 'unsupported') body = <Empty>this server has no bring-up check (needs vehicle-server with LR12)</Empty>;
  else if (state.kind === 'error') {
    body = (
      <div className="px-[14px] py-2">
        <div role="alert" className="text-term-red">
          ■ {state.message}
        </div>
        <TermButton className="mt-1" onClick={() => setNonce((value) => value + 1)}>
          Retry
        </TermButton>
      </div>
    );
  } else if (state.result.sessionId !== sessionId || state.result.gate !== gate) body = <Empty>Loading bring-up check...</Empty>;
  else {
    const { result } = state;
    const pending = result.needsYou.length;
    body = (
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
  }

  return (
    <div>
      <div className="flex items-center gap-1 px-[14px] py-1">
        <Segmented<BringupGate> label="Bring-up gate" value={gate} onChange={setGate} options={BRINGUP_GATES.map((g) => ({ value: g, label: g }))} />
      </div>
      {body}
    </div>
  );
};
