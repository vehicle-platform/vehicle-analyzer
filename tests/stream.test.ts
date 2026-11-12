import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketStreamClient, StreamStatus, parseStreamMessage } from '@/services/streamClient';

/** Minimal stand-in for the browser WebSocket: records sends, lets the test drive events. */
class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

function client(statuses: StreamStatus[], sources: string[] = []) {
  vi.stubGlobal('WebSocket', FakeSocket);
  const c = new WebSocketStreamClient({
    url: 'ws://localhost:8000/ws/live',
    token: 'secret',
    onFrame: () => {},
    onStatusChange: (s) => statuses.push(s),
    onHeartbeat: (hb) => sources.push(hb.source),
  });
  c.connect();
  return { c, ws: FakeSocket.last! };
}

describe('vehicle-server /ws/live client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends the token in a hello message, not in the URL', () => {
    const { ws } = client([]);
    ws.onopen!();
    expect(ws.url).not.toContain('secret');
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'hello', token: 'secret' });
  });

  it('reports the heartbeat source', () => {
    const sources: string[] = [];
    const { ws } = client([], sources);
    ws.onmessage!({ data: JSON.stringify({ type: 'heartbeat', payload: { source: 'mock', dropped: 0 } }) });
    expect(sources).toEqual(['mock']);
  });

  it('does not retry after the server rejects the hello', () => {
    vi.useFakeTimers();
    const statuses: StreamStatus[] = [];
    const { ws } = client(statuses);
    ws.onclose!({ code: 1008 });
    vi.advanceTimersByTime(10_000);
    expect(statuses.at(-1)).toBe('rejected');
    expect(FakeSocket.last).toBe(ws); // no new socket
  });

  it('reconnects after an ordinary close', () => {
    vi.useFakeTimers();
    const { ws } = client([]);
    ws.onclose!({ code: 1006 });
    vi.advanceTimersByTime(3_000);
    expect(FakeSocket.last).not.toBe(ws);
  });

  it('parses a heartbeat and ignores one without a source', () => {
    expect(parseStreamMessage({ type: 'heartbeat', payload: { source: 'none', dropped: 3 } }).heartbeat).toEqual({ source: 'none', dropped: 3 });
    expect(parseStreamMessage({ type: 'heartbeat', payload: {} }).heartbeat).toBeUndefined();
  });
});
