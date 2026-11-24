// Fixtures for row M625 (the M7 plan §3d; DECISIONS item 40, Sean
// 2026-11-24: "a Python service serves public/ from a sealed repository,
// and Surety verifies the bytes actually served against that directory.
// Include a changed-file case that must fail verification"). Lap-Lab's
// shape (Prototype iteration 3): a repository whose site lies under
// `public/` and whose service is `python3 server.py`, the standard
// library's HTTP server over that directory.
//
// The kernel file runs server.py as this test's child (the host's
// /usr/bin/python3, cwd the sealed artifact or a changed copy of it, bound
// to 127.0.0.1 on a free port), ended through its own handle at `t.after`.
// The sandbox file has the engine run it in a real `local_service` unit.
// Nothing here signals any process but this test's own child.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { SITE, freePort, hostGet, sha256 } from './static.mjs';

// The host's Python, pinned as a configuration's `runtime` by path and
// SHA-256 (the row: "the host's /usr/bin/python3, pinned by path and
// SHA-256"); the digest is computed at run time from the file the path
// names. `missing` says why there is none: a test that needs it fails with
// that reason, never skips (a skip is not a pass).
export const PYTHON_PATH = '/usr/bin/python3';
export function pythonRuntime() {
  if (!existsSync(PYTHON_PATH)) return { missing: `${PYTHON_PATH} does not exist on this host: row M625 needs the host's Python 3 (the Lap-Lab service's runtime)` };
  try {
    return { path: PYTHON_PATH, sha256: sha256(readFileSync(PYTHON_PATH)) };
  } catch (err) {
    return { missing: `${PYTHON_PATH} cannot be read: ${err.message}` };
  }
}
export function requirePython(py = pythonRuntime()) {
  assert.ok(!py.missing, py.missing);
  return py;
}

// The served directory, as the configuration declares it.
export const SERVED_ROOT = 'public';
export const SERVING = Object.freeze({ root: SERVED_ROOT, entry: 'index.html' });

// The site (static.mjs SITE: an entry, a stylesheet, a module script
// importing one local module, an image) under `public/`.
export const PUBLIC = Object.freeze(Object.fromEntries(Object.entries(SITE).map(([p, text]) => [`${SERVED_ROOT}/${p}`, text])));

// The bytes the changed-file case serves for one file instead of the
// sealed artifact's.
export const CHANGED_TEXT = 'body { color: red; }\n';
export const CHANGED_PATH = 'style.css';

// The variable that makes server.py serve a changed copy (the sandbox
// file's changed-file case): the path, relative to the served root, whose
// bytes the copy replaces with CHANGED_TEXT. The sealed artifact is never
// written: the copy is made in the service's own TMPDIR.
export const CHANGE_VARIABLE = 'SURETY_TEST_SERVE_CHANGED';

// server.py: the standard library only. It serves `public/` next to
// itself on 127.0.0.1 and the port in PORT, GET and HEAD only; a path with
// a `..` segment, or one that resolves outside the served directory, is
// 404. With CHANGE_VARIABLE set it copies the served directory to $TMPDIR
// file by file, replaces that one file's bytes, and serves the copy.
export const SERVER_PY = `# A static file service over public/ (row M625's fixture; Lap-Lab's shape).
import http.server
import os
import posixpath
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.realpath(os.path.join(HERE, ${JSON.stringify(SERVED_ROOT)}))
CHANGED = os.environ.get(${JSON.stringify(CHANGE_VARIABLE)}, '')

if CHANGED:
    copy = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'served')
    for base, dirs, files in os.walk(ROOT):
        rel = os.path.relpath(base, ROOT)
        os.makedirs(os.path.join(copy, rel), exist_ok=True)
        for name in files:
            with open(os.path.join(base, name), 'rb') as src, open(os.path.join(copy, rel, name), 'wb') as dst:
                dst.write(src.read())
    with open(os.path.join(copy, CHANGED), 'wb') as f:
        f.write(${JSON.stringify(CHANGED_TEXT)}.encode('utf-8'))
    ROOT = os.path.realpath(copy)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def refused(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if '..' in path.split('/'):
            return True
        target = os.path.realpath(os.path.join(ROOT, posixpath.normpath(path).lstrip('/')))
        return not (target == ROOT or target.startswith(ROOT + os.sep))

    def do_GET(self):
        if self.refused():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if self.refused():
            self.send_error(404)
            return
        super().do_HEAD()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8080'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    sys.stderr.write('serving %s on 127.0.0.1:%d\\n' % (ROOT, port))
    sys.stderr.flush()
    server.serve_forever()
`;

// The project's files beside the protected set: the site under public/ and server.py.
export const PYTHON_SITE = Object.freeze({ ...PUBLIC, 'server.py': SERVER_PY });

// A service-mode configuration over `content` running server.py with the
// host's Python (configContent's `over`): `serving` added unless null.
export const pythonService = (py, { serving = SERVING, ...over } = {}) => ({
  runtime: { path: py.path, sha256: py.sha256 },
  start: [py.path, 'server.py'],
  ...(serving === null ? {} : { serving }),
  ...over,
});

// server.py run by this test with cwd `dir` (the sealed artifact's
// directory or a changed copy of it) on a free port of 127.0.0.1; ended
// through its own handle at `t.after`. Returns the port.
export async function servePython(t, dir, { env = {} } = {}) {
  const py = requirePython();
  const port = await freePort();
  const child = spawn(py.path, ['server.py'], { cwd: dir, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PORT: String(port), PYTHONDONTWRITEBYTECODE: '1', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  t.after(() => child.kill('SIGTERM'));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server.py exited ${child.exitCode} before it answered: ${stderr}`);
    if ((await hostGet(port, '/')).status !== null) return port;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server.py did not answer on 127.0.0.1:${port}: ${stderr}`);
}

// Every object in a JSON value that carries string `root` and `entry`, with
// where it lies: [{at, root, entry}]. The row says what the environment read
// and the frozen deployment state, not under which key: the cases read the
// values wherever the engine puts them.
export function servingSpecsIn(value, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => servingSpecsIn(v, `${at}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    if (typeof value.root === 'string' && typeof value.entry === 'string') out.push({ at, root: value.root, entry: value.entry });
    for (const [k, v] of Object.entries(value)) servingSpecsIn(v, `${at}.${k}`, out);
  }
  return out;
}
export const holdsSpec = (value, spec) => servingSpecsIn(value).some((s) => s.root === spec.root && s.entry === spec.entry);
