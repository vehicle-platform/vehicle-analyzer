/**
 * True when `url` is a ws:// or http:// URL whose host is not the machine itself: the API
 * token (WS hello message, Authorization header) would cross the network unencrypted
 * (audit C-8). wss://, https:// and an unparsable URL give false.
 */
export function isCleartextRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return !(host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host));
}

export const CLEARTEXT_WARNING = 'Cleartext connection: the API token is sent unencrypted. Use wss:// or https:// outside this machine.';
