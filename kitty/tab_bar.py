"""Trusted host-only Kitty tab bar. Titles are data, never templates or code."""
import re
import unicodedata

COLORS = {
    "starting": (0xFFFFFF, 0x6B7280),
    "working": (0xFFFFFF, 0x2563EB),
    "attention": (0x111827, 0xFBBF24),
    "done": (0x111827, 0x4ADE80),
    "conflict": (0xFFFFFF, 0xDC2626),
    "merged": (0xFFFFFF, 0x46745B),
    "failed": (0xFFFFFF, 0xB91C1C),
}
MARKER = re.compile(r"pi-worktree:(starting|working|attention|done|conflict|merged|failed):(.*)", re.S)


def plain(text):
    return "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Cs", "Zl", "Zp") else c
                   for c in text[:1024])[:240]


def parse_title(title):
    match = MARKER.fullmatch(title)
    return (match.group(1), plain(match.group(2))[:120]) if match else (None, plain(title))


def draw_tab(draw_data, screen, tab, before, max_tab_length, index, is_last, extra_data):
    from kitty.fast_data_types import wcswidth
    from kitty.tab_bar import as_rgb

    limit = max(0, min(max_tab_length, screen.columns - before))
    if not limit:
        return before
    state, task = parse_title(tab.title)
    text = " {} {}{} ".format(index, (state + ": ") if state else "", task)
    if wcswidth(text) > limit:
        clipped = ""
        for character in text:
            if wcswidth(clipped + character) > limit - 1:
                break
            clipped += character
        text = clipped + "…"
    fg, bg = screen.cursor.fg, screen.cursor.bg
    try:
        if state:
            foreground, background = COLORS[state]
            screen.cursor.fg = as_rgb(foreground)
            screen.cursor.bg = as_rgb(background)
        screen.draw(text)  # Direct plain text; no Kitty title-template evaluation.
        return screen.cursor.x
    finally:
        screen.cursor.fg, screen.cursor.bg = fg, bg
