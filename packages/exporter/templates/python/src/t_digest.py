import math

#: The fewest centroids worth having.
_MIN_COMPRESSION = 8


class TDigest:
    """t-digest (Dunning): estimates quantiles of a stream of numbers, most accurately at the extremes (the 1st and 99th percentiles, the tail latencies
    people care about), in a few kilobytes.

    It keeps weighted centroids, each the mean of the values it stands for. A scale function k(q) = compression / (2 pi) x asin(2q - 1) limits how many
    values one centroid may stand for: a centroid covers at most one unit of k, which is wide in the middle of the distribution and narrow at both ends. So
    the rank error at quantile q is about 4 sqrt(q (1 - q)) / compression of the values: small in the tails, larger in the middle (the opposite of a KLL
    Sketch, which is the same everywhere). New values wait in a buffer and are merged into the centroids when the centroids and the buffer together reach
    `compression`. The smallest and largest value are kept exactly. Values cannot be removed. Two digests of the same compression merge. Size it with
    `size_t_digest` in sizing.py.
    """

    def __init__(self, compression: int) -> None:
        if not (compression >= _MIN_COMPRESSION):
            raise ValueError("A t-digest needs a compression of at least %d" % _MIN_COMPRESSION)
        self.compression = int(compression)
        self._centroids = []  # lists of [mean, weight]
        self._buffer = []
        self._min = math.inf
        self._max = -math.inf
        self._added = 0

    @property
    def count(self) -> int:
        """Values added."""
        return self._added

    @property
    def summary(self):
        """The centroids as they would be after merging everything held: (mean, weight) pairs."""
        return [tuple(c) for c in self._merged()]

    def _scale(self, q: float) -> float:
        return self.compression / (2 * math.pi) * math.asin(2 * min(1.0, max(0.0, q)) - 1)

    def _inverse_scale(self, k: float) -> float:
        return 1.0 if k >= self.compression / 4 else (math.sin(k * 2 * math.pi / self.compression) + 1) / 2

    def _merged(self):
        """Merges the centroids and the buffered values into centroids that respect the scale function's limit."""
        items = sorted([list(c) for c in self._centroids] + [[v, 1] for v in self._buffer], key=lambda c: c[0])
        if not items:
            return []
        total = sum(weight for _, weight in items)
        out = []
        current = list(items[0])
        before = 0
        limit = self._inverse_scale(self._scale(0) + 1) * total
        for nxt in items[1:]:
            if before + current[1] + nxt[1] <= limit:
                weight = current[1] + nxt[1]
                current = [(current[0] * current[1] + nxt[0] * nxt[1]) / weight, weight]
            else:
                before += current[1]
                out.append(current)
                limit = self._inverse_scale(self._scale(before / total) + 1) * total
                current = list(nxt)
        out.append(current)
        return out

    def add(self, value: float) -> None:
        if not math.isfinite(value):
            raise ValueError("A t-digest takes finite numbers")
        self._added += 1
        self._min = min(self._min, value)
        self._max = max(self._max, value)
        self._buffer.append(value)
        if len(self._centroids) + len(self._buffer) >= self.compression:
            self._centroids = self._merged()
            self._buffer = []

    def quantile(self, quantile: float):
        """The value at a quantile between 0 and 1 (0.99 is the 99th percentile), interpolated between centroids, or None when nothing was added."""
        centroids = self._merged()
        if not centroids:
            return None
        total = sum(weight for _, weight in centroids)
        target = quantile * total
        before = 0
        prev_center, prev_mean = 0.0, self._min
        for mean, weight in centroids:
            center = before + weight / 2
            if target <= center:
                span = center - prev_center
                return mean if span <= 0 else prev_mean + (mean - prev_mean) * (target - prev_center) / span
            prev_center, prev_mean = center, mean
            before += weight
        span = total - prev_center
        return self._max if span <= 0 else prev_mean + (self._max - prev_mean) * (target - prev_center) / span

    def rank_error(self, quantile: float) -> float:
        """The rank error to expect at a quantile, as a share of the values: 4 sqrt(q (1 - q)) / compression."""
        return 4 * math.sqrt(quantile * (1 - quantile)) / self.compression

    def merge(self, other: "TDigest") -> "TDigest":
        """The digest of both streams: the centroids and unmerged values of both, merged by the scale function. Needs the same compression."""
        if other.compression != self.compression:
            raise ValueError("t-digests merge only with the same compression")
        merged = TDigest(self.compression)
        merged._centroids = [list(c) for c in self._centroids] + [list(c) for c in other._centroids]
        merged._buffer = list(self._buffer) + list(other._buffer)
        merged._min = min(self._min, other._min)
        merged._max = max(self._max, other._max)
        merged._added = self._added + other._added
        merged._centroids = merged._merged()
        merged._buffer = []
        return merged
