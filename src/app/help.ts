import type { HelpGroup } from '@/ui/KeyBar';

export const HELP: HelpGroup[] = [
  {
    title: 'Views',
    keys: [
      { k: 'T', label: 'CAN trace' },
      { k: 'S', label: 'Sniffer' },
      { k: 'O', label: 'Oscilloscope' },
      { k: 'U', label: 'UDS' },
      { k: 'H', label: 'Health' },
      { k: 'F', label: 'Cluster' },
      { k: 'D', label: 'Defs & logs' },
      { k: 'E', label: 'Recorded sessions' },
      { k: 'A', label: 'Compare two sessions' },
      { k: 'G', label: 'Ride track' },
      { k: 'N', label: 'Ride history' },
      { k: 'I', label: 'Signal coverage' },
    ],
  },
  {
    title: 'Capture',
    keys: [
      { k: 'space', label: 'Pause / run the source (play / pause in log replay)' },
      { k: 'C', label: 'Clear captured data' },
      { k: '/', label: 'Focus the filter of this view' },
    ],
  },
  {
    title: 'Display',
    keys: [
      { k: 'X', label: 'Lean & cornering pane' },
      { k: 'L', label: 'Light / dark theme' },
      { k: '?', label: 'This help' },
    ],
  },
];

/** Status-bar text of the active source. */
export function describeSource(s: {
  source: string;
  isRunning: boolean;
  isReplaying: boolean;
  wsStatus: string;
  wsSource: string | null;
  usbRole: string;
  desktopKind: string;
}): string {
  const paused = s.isRunning ? '' : ', paused';
  switch (s.source) {
    case 'virtual':
      return `virtual bus ${s.isRunning ? 'running' : 'paused'}`;
    case 'websocket':
      return `ws ${s.wsStatus}${s.wsSource ? ` (${s.wsSource})` : ''}${paused}`;
    case 'webserial':
      return `usb can ${s.usbRole} bus${paused}`;
    case 'desktop':
      return `native ${s.desktopKind} ${s.usbRole} bus${paused}`;
    case 'server_session':
      return `session replay ${s.isReplaying ? 'playing' : 'stopped'}`;
    default:
      return `log replay ${s.isReplaying ? 'playing' : 'stopped'}`;
  }
}
