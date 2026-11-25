/** Hex helpers of the UDS panel (display and tester-input parsing). */

export const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
export const hexBytes = (b: number[]) => b.map(hex2).join(' ');

export function parseHexBytes(text: string): number[] | null {
  const clean = text.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (clean === '') return [];
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.substring(i, i + 2), 16));
  return out;
}
