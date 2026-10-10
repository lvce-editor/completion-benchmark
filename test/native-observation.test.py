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

    def test_async_type_details_do_not_change_label_endpoint(self):
        from PIL import Image
        fixtures = Path(__file__).with_name('fixtures') / 'native'
        warmup = Image.open(fixtures / 'zed-typescript-details-warmup.png')
        resolved = Image.open(fixtures / 'zed-typescript-details-resolved.png')
        filtered = Image.open(fixtures / 'zed-typescript-details-filtered.png')
        # Actual failed CI frames: details start after the label at x=386.
        self.assertNotEqual(warmup.tobytes(), resolved.tobytes())
        label = (0, 0, 49, 18)
        target = warmup.crop(label).tobytes()
        stale = filtered.crop(label).tobytes()
        self.assertTrue(native.matches_template(resolved.crop(label).tobytes(), target, stale))
        # At the moved filtered label, opening pixels must still be rejected.
        filtered_label = (9, 0, 58, 18)
        filtered_target = filtered.crop(filtered_label).tobytes()
        old_query = resolved.crop(filtered_label).tobytes()
        self.assertFalse(native.matches_template(old_query, filtered_target, old_query))
        self.assertTrue(native.matches_template(filtered_target, filtered_target, old_query))

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
