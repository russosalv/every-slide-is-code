// Which browser the export tool launches: CHROME_PATH, an installed Chrome, else the newest Playwright Chromium. No browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunchOptions, playwrightChromium } from '../../export/chrome.mjs';

const withEnv = (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v == null ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) v == null ? delete process.env[k] : (process.env[k] = v); }
};

test('CHROME_PATH wins', () => {
  assert.deepEqual(withEnv({ CHROME_PATH: '/x/chrome' }, resolveLaunchOptions), { executablePath: '/x/chrome' });
});

test('the newest chromium-NNNN of the Playwright cache is used (numeric order)', { skip: process.platform !== 'linux' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cache-'));
  for (const n of [999, 1226, 1254]) { const d = path.join(root, `chromium-${n}`, 'chrome-linux64'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'chrome'), ''); }
  fs.mkdirSync(path.join(root, 'chromium-9999'), { recursive: true });   // a folder without a binary is skipped
  withEnv({ PLAYWRIGHT_BROWSERS_PATH: root }, () => assert.equal(playwrightChromium(), path.join(root, 'chromium-1254', 'chrome-linux64', 'chrome')));
  fs.rmSync(root, { recursive: true });
});

test('no browser at all: a clear error at launch, not at import', { skip: process.platform !== 'linux' || fs.existsSync('/opt/google/chrome/chrome') || fs.existsSync('/usr/bin/google-chrome') || fs.existsSync('/usr/bin/google-chrome-stable') }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-empty-'));
  const opts = withEnv({ CHROME_PATH: null, PLAYWRIGHT_BROWSERS_PATH: root }, resolveLaunchOptions);
  assert.throws(() => ({ ...opts }), /No browser found.*CHROME_PATH/);
  fs.rmSync(root, { recursive: true });
});
