"""Tests for expand_colorway_rows — the ACS ColorwayCode splitter.

The bug these pin down: 'ALL_SOLID' was being split into two rows, 'ALL' and 'SOLID',
because it contains an underscore. That destroyed the `all_solid` join key, so a PPS row
with a blank COLOR (which the frontend normalises to `all_solid`) missed its exact match,
fell through to the no-colour fallback, and could take a *specific* colour's FOB instead.
Style IR7874 showed 4.72 (colourway 084) rather than 3.83 (ALL_SOLID).

Real multi-code lists like '011_066' must still split.
"""
import sql_backend

# Column layout used by these tests; index 2 is ColorwayCode.
CW = 2


def row(colorway, fob="1.00"):
    return ["SU27", "IR7874", colorway, "HIT", "CBDID", fob]


def colorways(result):
    return [r[CW] for r in result]


# ── ALL_* codes are ONE logical colourway and must not be split ───────────────
def test_all_solid_is_not_split():
    result = sql_backend.expand_colorway_rows(row("ALL_SOLID"), CW)
    assert colorways(result) == ["ALL_SOLID"]


def test_all_aop_and_all_htr_are_not_split():
    assert colorways(sql_backend.expand_colorway_rows(row("ALL_AOP"), CW)) == ["ALL_AOP"]
    assert colorways(sql_backend.expand_colorway_rows(row("ALL_HTR"), CW)) == ["ALL_HTR"]


def test_all_with_numeric_suffix_is_not_split():
    """ALL_011 / ALL_010 / ALL_531 exist in dbo.ACS and stay whole."""
    for code in ("ALL_011", "ALL_010", "ALL_531"):
        assert colorways(sql_backend.expand_colorway_rows(row(code), CW)) == [code]


def test_all_prefix_match_is_case_insensitive():
    assert colorways(sql_backend.expand_colorway_rows(row("all_solid"), CW)) == ["all_solid"]


def test_all_prefix_tolerates_surrounding_whitespace():
    assert colorways(sql_backend.expand_colorway_rows(row(" ALL_SOLID "), CW)) == [" ALL_SOLID "]


# ── genuine multi-code lists must still split ────────────────────────────────
def test_two_code_list_splits():
    result = sql_backend.expand_colorway_rows(row("011_066"), CW)
    assert colorways(result) == ["011", "066"]


def test_five_code_list_splits():
    result = sql_backend.expand_colorway_rows(row("006_010_065_323_410"), CW)
    assert colorways(result) == ["006", "010", "065", "323", "410"]


def test_split_preserves_every_other_column():
    result = sql_backend.expand_colorway_rows(row("011_066", fob="4.72"), CW)
    assert len(result) == 2
    for r in result:
        assert r[0] == "SU27" and r[1] == "IR7874" and r[3] == "HIT" and r[5] == "4.72"


def test_alphanumeric_codes_split():
    result = sql_backend.expand_colorway_rows(row("PHT_PHV_PC2"), CW)
    assert colorways(result) == ["PHT", "PHV", "PC2"]


# ── unchanged behaviour ──────────────────────────────────────────────────────
def test_plain_code_is_one_row():
    assert colorways(sql_backend.expand_colorway_rows(row("084"), CW)) == ["084"]


def test_allsolid_without_underscore_is_one_row():
    """'ALLSOLID' (2 rows in dbo.ACS) has no underscore, so it was never split."""
    assert colorways(sql_backend.expand_colorway_rows(row("ALLSOLID"), CW)) == ["ALLSOLID"]


def test_empty_colorway_is_one_row():
    assert colorways(sql_backend.expand_colorway_rows(row(""), CW)) == [""]


def test_missing_colorway_column_returns_row_untouched():
    base = row("011_066")
    assert sql_backend.expand_colorway_rows(base, -1) == [base]


def test_blank_fragments_are_dropped():
    assert colorways(sql_backend.expand_colorway_rows(row("011__066"), CW)) == ["011", "066"]
