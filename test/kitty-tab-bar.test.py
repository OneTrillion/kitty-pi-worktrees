"""Run with python3 test/kitty-tab-bar.test.py; no running Kitty needed."""
import importlib.util
import pathlib
import sys
import types
import unicodedata
import unittest

spec = importlib.util.spec_from_file_location("worktree_bar", pathlib.Path(__file__).parent.parent / "kitty" / "tab_bar.py")
bar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bar)


def width(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


class BarTest(unittest.TestCase):
    def test_fixed_marker_and_plain_text(self):
        for state in bar.COLORS:
            self.assertEqual(bar.parse_title("pi-worktree:" + state + ":task"), (state, "task"))
        self.assertIsNone(bar.parse_title("prefix pi-worktree:done:task")[0])
        self.assertIsNone(bar.parse_title("pi-worktree:#ff0000:task")[0])
        state, task = bar.parse_title("pi-worktree:done:{__import__('os').system('false')}\x1b\u202e")
        self.assertEqual(state, "done")
        self.assertIn("__import__", task)  # Literal text, never executed.
        self.assertNotIn("\x1b", task)
        self.assertNotIn("\u202e", task)

    def test_width_and_color_restoration(self):
        sys.modules["kitty"] = types.ModuleType("kitty")
        sys.modules["kitty.fast_data_types"] = types.SimpleNamespace(wcswidth=width)
        sys.modules["kitty.tab_bar"] = types.SimpleNamespace(as_rgb=lambda color: (color << 8) | 2)
        for limit in range(0, 40):
            cursor = types.SimpleNamespace(x=2, fg=123, bg=456)
            drawn = []
            def draw(text):
                drawn.append((text, cursor.fg, cursor.bg))
                cursor.x += width(text)
            screen = types.SimpleNamespace(cursor=cursor, columns=50, draw=draw)
            tab = types.SimpleNamespace(title="pi-worktree:working:修正/" + "x" * 200)
            end = bar.draw_tab(None, screen, tab, 2, limit, 1, True, None)
            self.assertLessEqual(end, 2 + limit)
            self.assertEqual((cursor.fg, cursor.bg), (123, 456))
            if limit:
                self.assertEqual(drawn[0][2], (bar.COLORS["working"][1] << 8) | 2)


if __name__ == "__main__":
    unittest.main()
