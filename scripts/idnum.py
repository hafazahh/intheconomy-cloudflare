"""Number and text normalisation shared by the micro parity scripts.

Why this exists: the Flask archive formats numbers with Python `{:,.0f}`
(comma thousands, dot decimals — `3,643,000`) while the Worker formats with
Indonesian id-ID (dot thousands, comma decimals — `3.643.000`). Both are
correct renderings of the same number, so a comparator that compares strings
reports a false failure on every card. The rules are therefore applied here,
once, and both scripts import them:

  * `unfmt`     — one token -> float, whichever locale wrote it
  * `canon`     — every number in a sentence -> canonical form
  * `norm_text` — strip tags, decode entities, collapse whitespace, canon numbers

`norm_text` also decodes HTML entities because the Worker escapes text
(`&` -> `&amp;`) while Jinja leaves literal template text alone (`&`).
"""

import html
import re

# A number, in either locale: grouped thousands with an optional decimal part,
# or a bare decimal. Matches `3.643.000`, `3,643,000`, `364,3`, `364.3`, `4,0`.
NUM_RE = re.compile(r"-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|-?\d+[.,]\d+")

ID_GROUPED = re.compile(r"-?\d{1,3}(?:\.\d{3})+(?:,\d+)?")  # 3.643.000 / 3.643,5
EN_GROUPED = re.compile(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?")  # 3,643,000 / 3,643.5
ID_DECIMAL = re.compile(r"-?\d+,\d+")  # 364,3


def unfmt(token):
    """`'3.643.000'` / `'3,643,000'` / `'364,3'` / `'364.3'` -> float."""
    text = token.replace("%", "").strip()
    if ID_GROUPED.fullmatch(text):
        return float(text.replace(".", "").replace(",", "."))
    if EN_GROUPED.fullmatch(text):
        return float(text.replace(",", ""))
    if ID_DECIMAL.fullmatch(text):
        return float(text.replace(",", "."))
    return float(text.replace(",", ""))


def canon(text):
    """Rewrite every number in `text` to a canonical form, leaving words alone."""
    def repl(match):
        token = match.group(0)
        try:
            return f"{unfmt(token):.10g}"
        except ValueError:
            return token

    return NUM_RE.sub(repl, text)


def norm_text(fragment):
    """Normalise one piece of rendered HTML for exact comparison."""
    text = re.sub(r"<[^>]+>", "", fragment)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return canon(text)
