import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('native', Path(__file__).resolve().parents[1] / 'src/native-observation.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeObservationTests(unittest.TestCase):
    def test_real_zed_templates_reject_stale_highlights_even_when_menu_moves(self):
        from PIL import Image
        fixtures = Path(__file__).with_name('fixtures') / 'native'
        opening = Image.open(fixtures / 'zed-typescript-opening.png').tobytes()
        filtering = Image.open(fixtures / 'zed-typescript-filtering.png').tobytes()
        moved_stale = Image.open(fixtures / 'zed-typescript-stale-shifted.png').tobytes()
        self.assertFalse(native.matches_template(opening, filtering, opening))
        self.assertFalse(native.matches_template(moved_stale, filtering, opening))
        self.assertTrue(native.matches_template(filtering, filtering, opening))

    def test_stale_suggestions_and_partial_paints_do_not_match(self):
        self.assertFalse(native.matches_template(b'Array:Arr', b'Array:Arra', b'Array:Arr'))
        self.assertFalse(native.matches_template(b'Array:Arr?', b'Array:Arra', b'Array:Arr'))
        self.assertTrue(native.matches_template(b'Array:Arra', b'Array:Arra', b'Array:Arr'))
        with self.assertRaises(ValueError):
            native.matches_template(b'Array', b'Array', b'Array')

    def test_two_matching_captures_and_conservative_clock_bounds(self):
        frames = [
            {'start': 2_000_000, 'end': 3_000_000, 'match': False},
            {'start': 4_000_000, 'end': 5_000_000, 'match': True},
            {'start': 6_000_000, 'end': 7_000_000, 'match': True},
        ]
        bounds = native.timing_bounds([0, 1_000_000], frames)
        self.assertEqual(bounds['firstMatchLowerMs'], 1)
        self.assertEqual(bounds['firstMatchUpperMs'], 5)
        self.assertEqual(bounds['stableUpperMs'], 7)
        self.assertEqual(bounds['maxCaptureMs'], 1)
        self.assertEqual(bounds['maxCaptureGapMs'], 1)
        with self.assertRaises(ValueError):
            native.timing_bounds([0, 1_000_000], frames[:2])
        frames[-1]['match'] = False
        with self.assertRaises(ValueError):
            native.timing_bounds([0, 1_000_000], frames)


unittest.main()
