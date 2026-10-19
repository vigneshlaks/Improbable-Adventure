
from .hash import DEFAULT_SEED, Item
from .min_hash import MinHash


def candidate_chance(similarity: float, rows: int, bands: int) -> float:
    """The chance that some band of `rows` rows agrees for two sets of similarity s, with `bands` bands: 1 - (1 - s^rows)^bands."""
    return 1 - (1 - similarity**rows) ** bands


def band_rows_for(k: int, threshold: float, recall: float) -> int:
    """The most rows a band can have while two sets exactly at the similarity `threshold` still become candidates with chance `recall`, for k minima cut into
    bands of that many (k // rows of them). More rows make a band pickier, so fewer look-alikes become candidates, but a similar pair must not be missed."""
    best = 1
    for rows in range(1, k + 1):
        if candidate_chance(threshold, rows, k // rows) >= recall:
            best = rows
        else:
            break
    return best


class LshIndex:
    """Locality-Sensitive Hashing index (Indyk and Motwani; the banding of Leskovec and others): finds, among many stored sets, the ones that are probably alike a
    query set, without comparing them all.

    Each stored set is cut to a MinHash signature of k minima, and the signature into bands of `rows` rows; two sets are candidates if, in some band, every row
    agrees. A pair of similarity s does that with chance 1 - (1 - s^rows)^bands. The rows are the most for which a pair exactly at the `threshold` is still found
    with chance `recall`, so a pair above the threshold is almost never missed, at the price of some pairs below it being found too: check the candidates with
    `MinHash.similarity`. Size it with `size_lsh` in sizing.py.
    """

    def __init__(self, k: int, threshold: float = 0.6, recall: float = 0.9, seed: int = DEFAULT_SEED) -> None:
        if not (k >= 1):
            raise ValueError("An LSH index needs at least one minimum")
        if not (0 < threshold < 1) or not (0 < recall < 1):
            raise ValueError("The threshold and the recall must be between 0 and 1")
        self.k = int(k)
        self.seed = seed
        self.rows = band_rows_for(self.k, threshold, recall)
        self.bands = self.k // self.rows
        self._buckets = [{} for _ in range(self.bands)]
        self._signatures = {}

    def _signature_of(self, items) -> MinHash:
        signature = MinHash(self.k, self.seed)
        for item in items:
            signature.add(item)
        return signature

    def _keys_of(self, signature):
        """The key of each band of a signature, or None for a band that saw nothing."""
        keys = []
        for band in range(self.bands):
            rows = signature[band * self.rows : (band + 1) * self.rows]
            keys.append(None if all(m == 2**32 for m in rows) else tuple(rows))
        return keys

    def add(self, id, items) -> None:
        """Stores a set under an id (a number or a string). Adding an id again replaces nothing: use a new id."""
        if id in self._signatures:
            raise ValueError("The id %r is already stored" % (id,))
        signature = self._signature_of(items)
        self._signatures[id] = signature
        for band, key in enumerate(self._keys_of(signature.signature)):
            if key is not None:
                self._buckets[band].setdefault(key, set()).add(id)

    def query(self, items):
        """The ids of the stored sets that are candidates for being alike the query set."""
        found = []
        for band, key in enumerate(self._keys_of(self._signature_of(items).signature)):
            if key is None:
                continue
            for id in self._buckets[band].get(key, ()):
                if id not in found:
                    found.append(id)
        return found

    def signature(self, id):
        """A stored set's MinHash, to check a candidate with `similarity`."""
        return self._signatures.get(id)
