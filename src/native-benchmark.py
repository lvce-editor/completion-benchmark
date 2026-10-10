"""Zed X11 screen-observed completion latency, deliberately separate from CDP."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from PIL import Image
from Xlib import display, X, XK
from Xlib.ext import xtest

spec = importlib.util.spec_from_file_location('observation', Path(__file__).with_name('native-observation.py'))
observation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observation)

parser = argparse.ArgumentParser()
parser.add_argument('--language', choices=['html', 'typescript'], required=True)
parser.add_argument('--prefix', required=True)
parser.add_argument('--inner', action='store_true')
args = parser.parse_args()
base = Path.cwd()
prefix = Path(args.prefix).resolve()


def save_json(suffix, data):
    Path(str(prefix) + suffix).write_text(json.dumps(data, indent=2) + '\n')


def descendants(pid):
    children = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            children.setdefault(int(stat[1]), []).append(int(entry.name))
        except (OSError, ValueError):
            pass
    result = []

    def visit(parent):
        for child in children.get(parent, []):
            visit(child)
            result.append(child)
    visit(pid)
    return result


def run(root):
    connection = display.Display()
    window = connection.screen().root
    profile = root / 'profile'
    (profile / 'config').mkdir(parents=True)
    fixture = root / 'workspace'
    fixture.mkdir()
    file = fixture / ('index.html' if args.language == 'html' else 'index.ts')
    original = (base / 'fixtures' / args.language / file.name).read_text()
    file.write_text(original)
    providers = base / '.tmp/apps/zed-lsp/node_modules'
    settings = {
        'telemetry': {'diagnostics': False, 'metrics': False}, 'auto_update': False,
        'session': {'trust_all_worktrees': True}, 'features': {'edit_prediction_provider': 'none'},
        'cursor_blink': False, 'show_completion_documentation': False,
        'format_on_save': 'off', 'ensure_final_newline_on_save': False,
        'inlay_hints': {'enabled': False}, 'auto_install_extensions': {},
        'languages': {
            'HTML': {'language_servers': ['vscode-html-language-server'], 'show_edit_predictions': False},
            'TypeScript': {'language_servers': ['typescript-language-server'], 'show_edit_predictions': False},
        },
        'lsp': {
            'vscode-html-language-server': {'binary': {'path': shutil.which('node'), 'arguments': [str(providers / '@zed-industries/vscode-langservers-extracted/bin/vscode-html-language-server'), '--stdio']}},
            'typescript-language-server': {'binary': {'path': shutil.which('node'), 'arguments': [str(providers / 'typescript-language-server/lib/cli.mjs'), '--stdio']}},
        },
    }
    (profile / 'config/settings.json').write_text(json.dumps(settings))
    (profile / 'extensions/installed').mkdir(parents=True)
    shutil.copytree(base / '.tmp/apps/zed-html', profile / 'extensions/installed/html')
    env = {**os.environ, 'ZED_ALLOW_EMULATED_GPU': '1', 'ZED_STATELESS': '1'}
    subprocess.run(['gnome-keyring-daemon', '--unlock'], input=b'\n', capture_output=True, env=env, check=True, timeout=10)
    setup = json.loads((base / '.tmp/setup.json').read_text())
    process = None
    result = {'status': 'failed', 'error': 'Native harness did not complete'}

    def capture(box=None, suffix=None):
        start = time.monotonic_ns()
        if box is None:
            geometry = window.get_geometry()
            box = (0, 0, geometry.width, geometry.height)
        x, y, right, bottom = box
        raw = window.get_image(x, y, right - x, bottom - y, X.ZPixmap, 0xffffffff)
        image = Image.frombytes('RGB', (right - x, bottom - y), raw.data, 'raw', 'BGRX')
        end = time.monotonic_ns()
        if suffix:
            image.save(str(prefix) + suffix + '.png')
        return image, start, end

    def key(name):
        codes = [connection.keysym_to_keycode(XK.string_to_keysym({'ctrl': 'Control_L'}.get(part, part))) for part in name.split('+')]
        if not all(codes):
            raise RuntimeError('Unmapped X11 key: ' + name)
        start = time.monotonic_ns()
        for code in codes:
            xtest.fake_input(connection, X.KeyPress, code)
        for code in reversed(codes):
            xtest.fake_input(connection, X.KeyRelease, code)
        connection.sync()
        return [start, time.monotonic_ns()]

    def ocr(image, suffix):
        path = str(prefix) + suffix + '.png'
        image.save(path)
        response = subprocess.run(['tesseract', path, 'stdout', '--psm', '11', 'tsv'], capture_output=True, text=True, check=True, timeout=15)
        Path(str(prefix) + suffix + '.tsv').write_text(response.stdout)
        return [line.split('\t') for line in response.stdout.splitlines()[1:] if len(line.split('\t')) == 12]

    def buffer_text():
        key('ctrl+a')
        key('ctrl+c')
        # Clipboard is private to this Xvfb server. Copy is a discarded semantic
        # check, outside every timed interval, and avoids save/file-watcher races.
        time.sleep(.15)
        copied = subprocess.run(['xclip', '-selection', 'clipboard', '-o'], capture_output=True, text=True, check=True, timeout=5).stdout
        key('ctrl+End')
        return copied

    def confirm_buffer(expected):
        text = buffer_text()
        if text != expected:
            raise RuntimeError('Buffer differs from expected completion: ' + repr(text))

    def interrupted(signum, frame):
        raise RuntimeError('Native observation interrupted by signal ' + str(signum))

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with open(str(prefix) + '.log', 'w') as log:
            process = subprocess.Popen([setup['zed']['binary'], '--user-data-dir', str(profile), str(file)], env=env, stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + 30
            window_id = None
            while time.monotonic() < deadline and process.poll() is None:
                found = subprocess.run(['xdotool', 'search', '--class', 'zed'], capture_output=True, text=True, timeout=5)
                if found.returncode == 0:
                    window_id = found.stdout.splitlines()[0]
                    break
                time.sleep(.1)
            if window_id is None:
                raise RuntimeError('Zed did not open a window')
            subprocess.run(['xdotool', 'windowsize', window_id, '1280', '900', 'windowfocus', window_id], check=True, timeout=5)
            time.sleep(2)
            key('ctrl+End')
            expected = 'a' if args.language == 'html' else 'Array'
            warmup_deadline = time.monotonic() + 60
            requests = 0
            matches = []
            while time.monotonic() < warmup_deadline:
                key('Escape')
                key('ctrl+space')
                requests += 1
                time.sleep(.3)
                opening, _, _ = capture()
                rows = ocr(opening, f'-warmup-{requests}')
                # Exclude the file contents, toolbar and status bar.
                matches = [row for row in rows if row[-1].lower() == expected.lower() and (200 if args.language == 'html' else 130) < int(row[7]) < 600 and int(row[6]) < 900]
                if matches:
                    break
            if not matches:
                raise RuntimeError('No expected opening suggestion after discarded readiness requests')
            opening.save(str(prefix) + '-opening-warmup.png')
            key('h' if args.language == 'html' else 'a')
            time.sleep(.5)
            filtering, _, _ = capture(suffix='-filtering-warmup')
            filtered_rows = ocr(filtering, '-filtering-warmup')
            # Prove which completion the warmup menu represents. The exact copied
            # buffer is stronger than OCR (e.g. h1 vs hl); templates exclude caret.
            key('Return')
            accepted = original + ('h1' if args.language == 'html' else 'ay')
            confirm_buffer(accepted)
            for _ in range(2):
                key('ctrl+z')
                time.sleep(.2)
                if buffer_text() == original:
                    break
            if buffer_text() != original:
                raise RuntimeError('Warmup undo did not restore the exact original fixture')
            row = min(matches, key=lambda value: (int(value[7]), int(value[6])))
            x, y, width, height = map(int, row[6:10])
            # Observe labels only: TypeScript resolve adds asynchronous type
            # details to the right, which are not part of completion readiness.
            box = (x - 2, y - (30 if args.language == 'html' else 2), x + (60 if args.language == 'html' else width + 2), y + height + 2)
            boxes = [box, box]
            if args.language == 'typescript':
                filtered_matches = [value for value in filtered_rows if value[-1] == 'Array' and abs(int(value[7]) - y) < 3]
                if not filtered_matches:
                    raise RuntimeError('No filtered Array label for query-qualified template')
                filtered_row = min(filtered_matches, key=lambda value: int(value[6]))
                fx, fy, fw, fh = map(int, filtered_row[6:10])
                boxes[1] = (fx - 2, fy - 2, fx + fw + 2, fy + fh + 2)
            screens = [opening, filtering]
            templates = [screen.crop(region).tobytes() for screen, region in zip(screens, boxes)]
            stale_templates = [screens[1 - index].crop(region).tobytes() for index, region in enumerate(boxes)]
            for index, template in enumerate(templates):
                observation.matches_template(template, template, stale_templates[index])
            opening.crop(boxes[0]).save(str(prefix) + '-opening-template.png')
            filtering.crop(boxes[1]).save(str(prefix) + '-filtering-template.png')
            key('Escape')
            time.sleep(.2)
            calibration = []
            for _ in range(10):
                _, start, end = capture(box)
                calibration.append((end - start) / 1e6)
            samples = []
            for index, (action, phase) in enumerate([('ctrl+space', 'opening'), ('h' if args.language == 'html' else 'a', 'filtering')]):
                box = boxes[index]
                target = templates[index]
                stale = stale_templates[index]
                before, _, _ = capture(box)
                if observation.matches_template(before.tobytes(), target, stale):
                    raise RuntimeError('Pre-action screen already matches the target template')
                injection = key(action)
                deadline = time.monotonic() + 10
                consecutive = 0
                frames = []
                while time.monotonic() < deadline:
                    image, start, end = capture(box)
                    matched = observation.matches_template(image.tobytes(), target, stale)
                    frames.append({'start': start, 'end': end, 'match': matched})
                    consecutive = consecutive + 1 if matched else 0
                    if consecutive >= 2:
                        break
                    time.sleep(.005)
                if consecutive < 2:
                    capture(suffix='-' + phase + '-timeout')
                    save_json('-' + phase + '-timeout.json', {'injection': injection, 'frames': frames})
                    raise RuntimeError('Query-qualified template timeout: ' + phase)
                capture(suffix='-' + phase + '-measured')
                samples.append({'phase': phase, 'region': box, 'injection': injection, 'frames': frames, **observation.timing_bounds(injection, frames)})
            # Revalidate the actual timed filter's completion, without retrying it.
            key('Return')
            confirm_buffer(accepted)
            result = {
                'status': 'passed', 'warmupRequests': requests,
                'openingMs': samples[0]['stableUpperMs'], 'filteringMs': samples[1]['stableUpperMs'],
                'samples': samples, 'regions': boxes, 'captureCalibrationMs': calibration,
                'templateSha256': [hashlib.sha256(template).hexdigest() for template in templates],
                'confirmedText': accepted, 'profile': str(root), 'settings': settings,
                'clock': 'Python monotonic_ns for XTest submission/round-trip and XGetImage brackets',
                'endpoint': 'Two consecutive exact suggestion-template captures; verified completion insertion; stale-template rejection',
                'unsupported': setup['zed']['unsupported'],
            }
    except Exception as error:
        result = {'status': 'failed', 'error': str(error)}
        try:
            capture(suffix='-failure')
        except Exception:
            pass
    finally:
        if process is not None:
            owned = descendants(process.pid)
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if (profile / 'logs').exists():
            shutil.copytree(profile / 'logs', str(prefix) + '-logs', dirs_exist_ok=True)
            if (profile / 'logs/Zed.log').exists():
                shutil.copyfile(profile / 'logs/Zed.log', str(prefix) + '-application.log')
        save_json('-native.json', result)
        connection.close()
    return 0 if result['status'] == 'passed' else 1


if args.inner:
    sys.exit(run(Path(os.environ['COMPLETION_NATIVE_ROOT'])))
else:
    with tempfile.TemporaryDirectory(prefix='completion-native-zed-') as directory:
        env = dict(os.environ)
        for kind in ['CONFIG', 'DATA', 'CACHE', 'STATE']:
            path = Path(directory) / kind.lower()
            path.mkdir()
            env['XDG_' + kind + '_HOME'] = str(path)
        env['COMPLETION_NATIVE_ROOT'] = directory
        # Isolate bus/keyring/portals before launch, as well as editor and XDG state.
        child = subprocess.Popen(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), '--inner', '--language', args.language, '--prefix', str(prefix)], env=env)
        def forward_signal(signum, frame):
            for pid in descendants(child.pid):
                try:
                    cmd = (Path('/proc') / str(pid) / 'cmdline').read_bytes()
                    if b'--inner' in cmd and b'native-benchmark.py' in cmd:
                        os.kill(pid, signum)
                except OSError:
                    pass
        signal.signal(signal.SIGTERM, forward_signal)
        signal.signal(signal.SIGINT, forward_signal)
        exit_code = child.wait()
        # D-Bus activated portals/keyring can outlive the session and leave a
        # FUSE mount in this private cache. Reconcile only processes with our
        # exact isolated XDG environment; never touch the desktop's services.
        marker = ('XDG_CACHE_HOME=' + env['XDG_CACHE_HOME']).encode()
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                if marker in (entry / 'environ').read_bytes().split(b'\0'):
                    os.kill(int(entry.name), signal.SIGTERM)
            except (OSError, ValueError):
                pass
        mount = str(Path(directory) / 'cache/doc')
        if any(line.split()[4] == mount for line in Path('/proc/self/mountinfo').read_text().splitlines()):
            subprocess.run(['fusermount3', '-uz', mount], check=True)
    sys.exit(exit_code)
