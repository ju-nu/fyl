"""Shared setup of the Python tests: the repository, the version under test, the native fyl binary for this host and a
loader for the scripts under scripts/. The test modules import it by name (`unittest discover -s tests` and
scripts/test_py.py put tests/ on the path)."""
import importlib.util
import json
import os
from pathlib import Path
import platform

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
# The native builds dist/cli/<version>/ holds, by (platform.system(), platform.machine()).
BUILDS = {('Linux', 'x86_64'): 'fyl-linux-x86_64', ('Linux', 'aarch64'): 'fyl-linux-arm64',
          ('Darwin', 'x86_64'): 'fyl-macos-x86_64', ('Darwin', 'arm64'): 'fyl-macos-arm64'}
HOST = BUILDS.get((platform.system(), platform.machine()))
# The committed binary of this version for this host. FYL_CLI_BINARY runs the tests against another build instead,
# e.g. cli-rs/target/release/fyl before the binaries are rebuilt.
NATIVE = (Path(os.environ['FYL_CLI_BINARY']).absolute() if os.environ.get('FYL_CLI_BINARY')
          else ROOT / 'dist' / 'cli' / VERSION / HOST if HOST else None)
# One policy for every module that runs fyl: only a host without a native build skips (decorate the class with
# `unittest.skipIf(NATIVE is None, NO_BUILD)`); a binary that should be there and isn't fails (require_native()).
NO_BUILD = 'no native fyl build for this host'


def require_native():
    """Fails the run when the binary is missing (a mistyped FYL_CLI_BINARY, a version bumped before the rebuild): a
    skip would report a pass that tested nothing."""
    if NATIVE is None or not NATIVE.is_file():
        raise AssertionError('native fyl binary missing: {}'.format(NATIVE))


def require_node_modules():
    """The tests that start the Worker need the npm dependencies, like npm run ci; without them they fail, not skip."""
    if not (ROOT / 'node_modules' / 'wrangler').is_dir():
        raise AssertionError('node_modules is missing: run npm ci first')


def ciphertext_size(plaintext):
    """C(P) of docs/E2EE.md §6."""
    return 184 + plaintext + 16 * max(1, -(-plaintext // 65536))


def load_script(name):
    """scripts/<name>.py as a module, loaded by path (scripts/ is no package)."""
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
