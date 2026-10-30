// A static site's files, and a tree written from them, shared by the
// static-site developer tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SITE = Object.freeze({
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script type="module" src="./js/app.js"></script></head><body><img src="img/logo.svg" alt="logo"><p>Lap Lab</p></body></html>\n',
  'style.css': 'body { font-family: sans-serif; }\n',
  'js/app.js': "import { lap } from './lap.js';\ndocument.body.dataset.lap = lap;\n",
  'js/lap.js': 'export const lap = 1;\n',
  'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n',
});

export function writeTree(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
