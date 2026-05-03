/**
 * Linear-interpolation percentile of a pre-sorted ascending numeric array.
 * Returns null for an empty input. Returns an integer (rounded) for non-empty.
 *
 * @param {number[]} sortedAsc  ascending-sorted values
 * @param {number} p            percentile in [0, 100]
 * @returns {number | null}
 */
export function pickPercentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const value = sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  return Math.round(value);
}
