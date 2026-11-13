// Which browser to launch: CHROME_PATH, else an installed Google Chrome, else the newest Chromium that
// Playwright downloaded (`npx playwright install chromium`). Returns playwright-core launch options.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const CHROME_PATHS = {
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].map(v => process.env[v] && path.join(process.env[v], 'Google', 'Chrome', 'Application', 'chrome.exe')).filter(Boolean),
};

// Where Playwright keeps its browsers, and the binary inside one chromium-NNNN folder.
function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}
const INSIDE = {
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  darwin: ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'],
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
};

export function playwrightChromium() {
  const root = playwrightCache();
  let dirs = [];
  try { dirs = fs.readdirSync(root).map(d => /^chromium-(\d+)$/.exec(d)).filter(Boolean).sort((a, b) => b[1] - a[1]); } catch { return null; }
  for (const [name] of dirs) for (const rel of INSIDE[process.platform] || INSIDE.linux) {
    const p = path.join(root, name, rel);
    if (exists(p)) return p;
  }
  return null;
}

export function resolveLaunchOptions() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH };
  if ((CHROME_PATHS[process.platform] || CHROME_PATHS.linux).some(exists)) return { channel: 'chrome' };
  const pw = playwrightChromium();
  if (pw) return { executablePath: pw };
  // The options are resolved when the module loads, but commands that need no browser (help, bundle, fonts) must still run:
  // the getter throws only when a launch spreads these options.
  return { get executablePath() { throw new Error('No browser found: install Google Chrome, set CHROME_PATH to a Chrome/Chromium binary, or run `npx playwright-core install chromium`.'); } };
}
