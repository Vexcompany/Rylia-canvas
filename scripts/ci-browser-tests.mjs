import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const baseURL = 'http://127.0.0.1:5173';
const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--strictPort'], {
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});

let browser;
let serverExited = false;
server.once('exit', () => { serverExited = true; });

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error('Vite dev server exited before becoming ready.');
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the Vite dev server.');
}

try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => console.error('[browser page error]', error.message));
  await page.goto(`${baseURL}/tests/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__ryliaCanvasTestsDone === true, null, { timeout: 600_000 });

  const report = await page.evaluate(() => {
    const result = window.__ryliaCanvasTests;
    return {
      ok: result?.ok === true,
      passed: result?.passed ?? 0,
      failed: result?.failed ?? 0,
      errors: result?.errors ?? 0,
      suites: (result?.suites ?? [])
        .filter((suite) => suite.error || suite.results.some((item) => !item.pass))
        .map((suite) => ({
          name: suite.name,
          error: suite.error,
          failures: suite.results.filter((item) => !item.pass).map((item) => ({
            message: item.message,
            detail: item.detail,
          })),
        })),
    };
  });

  console.log('Browser regression report:');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error('Rylia Canvas CI verification failed:', error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
