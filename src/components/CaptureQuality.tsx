import React from 'react';
import type { ConnCaptureSummary } from '../services/connCaptureParser';
import { captureWarnings } from '../services/captureQuality';
import { Na, cn } from '../ui/primitives';
import { TD, TH } from '../ui/panel-parts';

interface CaptureQualityProps {
  summary: ConnCaptureSummary;
}

const idHex = (id: number, extended: boolean) => `0x${id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0')}`;
const gap = (value: number | null) => (value === null ? <Na /> : `${value.toFixed(3)} ms`);

export const CaptureQuality: React.FC<CaptureQualityProps> = ({ summary }) => {
  const warnings = captureWarnings(summary);
  const rows = summary.block ? [...summary.block.rows].sort((a, b) => a.id - b.id || Number(a.extended) - Number(b.extended)) : [];
  const ids = summary.block?.end.ids;

  return (
    <section
      data-testid="capture-quality"
      aria-label="Capture quality"
      className="shrink-0 border-b border-term-rule bg-term-raise"
    >
      <div className="flex items-baseline gap-3 border-b border-term-rule px-[14px] py-[6px]">
        <span className="font-semibold text-term-hi">Capture quality</span>
        <span className="text-term-dim">conn listen-only capture · vehicle bus</span>
        <span className={cn('ml-auto', warnings.length > 0 ? 'text-term-amber' : 'text-term-dim')}>
          {warnings.length > 0 ? `! ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'no warnings'}
        </span>
      </div>

      <dl className="grid grid-cols-6 gap-x-4 px-[14px] py-[6px] text-term-dim">
        <div>
          <dt className="text-term-faint">frames</dt>
          <dd className="text-term-hi">{summary.frames.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-term-faint">IDs</dt>
          <dd className="text-term-hi">{ids === undefined ? <Na /> : ids}</dd>
        </div>
        <div>
          <dt className="text-term-faint">duration</dt>
          <dd className="text-term-hi">{summary.durationS.toFixed(3)} s</dd>
        </div>
        <div>
          <dt className="text-term-faint">restarts</dt>
          <dd className={cn(summary.restarts > 0 ? 'text-term-amber' : 'text-term-hi')}>{summary.restarts}</dd>
        </div>
        <div>
          <dt className="text-term-faint">skipped lines</dt>
          <dd className="text-term-hi">{summary.skippedLines}</dd>
        </div>
        <div>
          <dt className="text-term-faint">malformed frames</dt>
          <dd className="text-term-hi">{summary.malformedFrames}</dd>
        </div>
      </dl>

      {warnings.length > 0 ? (
        <ul data-testid="capture-warnings" className="border-t border-term-rule px-[14px] py-[5px] text-term-amber">
          {warnings.map((warning) => (
            <li key={warning}>! {warning}</li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-term-rule px-[14px] py-[5px] text-term-dim">No capture-quality warnings.</p>
      )}

      <div className="max-h-[32vh] overflow-auto border-t border-term-rule">
        {rows.length === 0 ? (
          <p className="px-[14px] py-[6px] text-term-faint">No per-ID summary rows in this capture.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-term-raise">
              <tr>
                <th className={cn(TH, 'pl-[14px]')}>id</th>
                <th className={TH}>S/X</th>
                <th className={cn(TH, 'text-right')}>count</th>
                <th className={cn(TH, 'text-right')}>min gap</th>
                <th className={cn(TH, 'text-right')}>max gap</th>
                <th className={TH}>watched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.extended ? 'x' : 's'}-${row.id}`}>
                  <td className={cn(TD, 'pl-[14px] text-term-hi')}>{idHex(row.id, row.extended)}</td>
                  <td className={cn(TD, 'text-term-dim')}>{row.extended ? 'X' : 'S'}</td>
                  <td className={cn(TD, 'text-right')}>{row.count.toLocaleString()}</td>
                  <td className={cn(TD, 'text-right text-term-dim')}>{gap(row.minGapMs)}</td>
                  <td className={cn(TD, 'text-right text-term-dim')}>{gap(row.maxGapMs)}</td>
                  <td className={cn(TD, row.watched ? 'text-term-amber' : 'text-term-faint')}>{row.watched ? 'W' : <Na />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
