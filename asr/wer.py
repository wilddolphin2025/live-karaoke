"""Word error rate helpers (no external deps)."""
import re


def normalize(text: str) -> list[str]:
    """Lowercase, fold ё->е, drop punctuation, split into words."""
    text = text.lower().replace("ё", "е")
    return re.sub(r"[^\w\s]", " ", text).split()


def edit_distance(ref: list[str], hyp: list[str]) -> int:
    """Levenshtein distance over words (substitutions + insertions + deletions)."""
    d = list(range(len(hyp) + 1))
    for i, rw in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, hw in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rw != hw))
    return d[-1]


def wer(pairs: list[tuple[str, str]]) -> float:
    """Corpus WER for (reference, hypothesis) pairs, as a fraction."""
    errors = sum(edit_distance(normalize(r), normalize(h)) for r, h in pairs)
    words = sum(len(normalize(r)) for r, _ in pairs)
    return errors / max(words, 1)
