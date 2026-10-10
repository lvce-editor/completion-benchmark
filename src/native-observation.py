"""Pixel endpoint shared by the native harness and adversarial unit tests."""


def matches_template(pixels, target, stale):
    if target == stale:
        raise ValueError("Opening and filtered suggestion templates are indistinguishable")
    return pixels == target and pixels != stale


def timing_bounds(injection, frames):
    """Bound the first matching capture; also retain the two-capture endpoint.

    XGetImage is synchronous, but the read itself spans an interval. No physical
    display or application-dispatch timestamp is inferred from these brackets.
    """
    if len(frames) < 2 or not all(frame['match'] for frame in frames[-2:]):
        raise ValueError("Two consecutive matching captures are required")
    first = frames[-2]
    previous = frames[-3] if len(frames) >= 3 else None
    return {
        'firstMatchLowerMs': max(0, ((previous['start'] if previous else injection[0]) - injection[1]) / 1e6),
        'firstMatchUpperMs': (first['end'] - injection[0]) / 1e6,
        'stableUpperMs': (frames[-1]['end'] - injection[0]) / 1e6,
        'injectionRoundTripMs': (injection[1] - injection[0]) / 1e6,
        'maxCaptureMs': max((frame['end'] - frame['start']) / 1e6 for frame in frames),
        'maxCaptureGapMs': max((b['start'] - a['end']) / 1e6 for a, b in zip(frames, frames[1:])) if len(frames) > 1 else 0,
    }
