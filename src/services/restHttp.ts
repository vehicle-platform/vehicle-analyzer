import { isRecord } from './schemas/restCommon';

/** Plain HTTP layer of the read-only vehicle-server clients: request building and the shared error mapping. */

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
}

const trimBase = (base: string) => base.trim().replace(/\/+$/, '');

/** Builds a request: the token only ever lands in the headers. */
export function buildRequest(baseUrl: string, token: string, path: string, query?: Record<string, string | number | undefined>): BuiltRequest {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return {
    url: `${trimBase(baseUrl)}${path}${qs ? `?${qs}` : ''}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
}

/** Maps an HTTP failure to a message for the user (the token never appears in it). */
export async function describeHttpError(res: Pick<Response, 'status' | 'statusText' | 'text'>): Promise<string> {
  if (res.status === 401) return 'Unauthorized (401): the API token is missing or wrong.';
  if (res.status === 404) return 'Not found (404): unknown session.';
  if (res.status === 422) {
    let detail = '';
    try {
      const body = JSON.parse(await res.text()) as unknown;
      const d = isRecord(body) ? body.detail : undefined;
      detail = typeof d === 'string' ? d : d === undefined ? '' : JSON.stringify(d);
    } catch {
      // body was not JSON
    }
    return `Rejected (422): ${detail || 'bad signal names or parameters'}`;
  }
  return `Server error (${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/**
 * GET + JSON with the shared error mapping. `onHttpError` runs first on a non-2xx answer, so a
 * caller can turn a specific body (e.g. a 404 detail) into its own error before the generic one.
 */
export async function getJson(req: BuiltRequest, fetchFn: FetchLike, onHttpError?: (res: Response) => Promise<void>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(req.url, { headers: req.headers });
  } catch {
    throw new Error('Cannot reach the server (network error, wrong URL or CORS).');
  }
  if (!res.ok) {
    await onHttpError?.(res);
    throw new Error(await describeHttpError(res));
  }
  try {
    return await res.json();
  } catch {
    throw new Error('The server answered with something that is not JSON.');
  }
}

export async function readDetail(res: Response): Promise<string> {
  try {
    const body = JSON.parse(await res.text()) as unknown;
    return isRecord(body) && typeof body.detail === 'string' ? body.detail : '';
  } catch {
    return '';
  }
}
