"""Pure unit tests for the WER math - no GPU or server needed."""
from asr.wer import edit_distance, normalize, wer


def test_normalize_strips_punctuation_case_and_yo():
    assert normalize("Ёлка, Привет!") == ["елка", "привет"]


def test_edit_distance_counts_sub_ins_del():
    assert edit_distance("a b c".split(), "a x c".split()) == 1  # substitution
    assert edit_distance("a b".split(), "a b c".split()) == 1    # insertion
    assert edit_distance("a b c".split(), "a c".split()) == 1    # deletion


def test_wer_perfect_and_total_miss():
    assert wer([("привет мир", "Привет, мир!")]) == 0.0
    assert wer([("один два", "")]) == 1.0
