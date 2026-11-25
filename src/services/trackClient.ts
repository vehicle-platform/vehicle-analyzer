/**
 * Read-only client for GET /sessions/{id}/track (roadmap A7a). The response is relative
 * to the first usable GNSS sample; it never contains an absolute position.
 */

import { buildRequest, getJson, readDetail, type BuiltRequest, type FetchLike } from './restHttp';
import { parseTrackResponse, type TrackResponse } from './schemas/track';

export { parseTrackResponse } from './schemas/track';
export type { TrackColor, TrackFrame, TrackMethod, TrackResponse, TrackSegment } from './schemas/track';

export interface TrackQuery {
  maxPoints?: number;
  minHeadingSpeedMps?: number;
  color?: string;
  fromMs?: number;
  toMs?: number;
}

/** The server answered 404 `session has no GPS`; this is a state, not an error. */
export class NoGpsInSessionError extends Error {
  constructor() {
    super('No GPS in this session.');
    this.name = 'NoGpsInSessionError';
  }
}

export const trackRequest = (base: string, token: string, id: string, q: TrackQuery = {}): BuiltRequest =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/track`, {
    max_points: q.maxPoints,
    min_heading_speed_mps: q.minHeadingSpeedMps,
    color: q.color,
    from_ms: q.fromMs,
    to_ms: q.toMs,
  });

export class TrackClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: FetchLike = (u, i) => fetch(u, i)
  ) {}

  public async getTrack(id: string, q: TrackQuery = {}): Promise<TrackResponse> {
    const request = trackRequest(this.baseUrl, this.token, id, q);
    return parseTrackResponse(
      await getJson(request, this.fetchFn, async (res) => {
        if (res.status === 404 && (await readDetail(res)) === 'session has no GPS') throw new NoGpsInSessionError();
      })
    );
  }
}
