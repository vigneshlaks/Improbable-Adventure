/** Plain-text formatting shared by the reports. */
export const pct = (x: number): string => (x < 0.001 ? `${(x * 100).toPrecision(2)}%` : `${Math.round(x * 1000) / 10}%`);
export const number = (x: number): string => Math.round(x).toLocaleString("en-US");

export function size(bits: number): string {
  if (bits < 8 * 1024) return `${number(bits)} bits`;
  const bytes = bits / 8;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
