import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { chromium } from 'playwright-core';
import { startFixtureServer } from './fixture-server.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const extensionPath = process.env.MEDIA_SCOUT_EXTENSION_PATH || path.join(root, 'dist', 'media-scout-downloader');
if (!path.isAbsolute(extensionPath)) throw new Error('MEDIA_SCOUT_EXTENSION_PATH must be absolute when supplied.');
const browserExecutable = process.env.MEDIA_SCOUT_BROWSER === 'playwright' ? chromium.executablePath() : process.env.MEDIA_SCOUT_BROWSER;
const browserLabel = process.env.MEDIA_SCOUT_BROWSER_LABEL || path.basename(browserExecutable || 'browser', path.extname(browserExecutable || ''));
const browserExecutableVersion = process.env.MEDIA_SCOUT_BROWSER_VERSION || 'not supplied';
const candidateCommit = process.env.MEDIA_SCOUT_CANDIDATE_COMMIT || 'working tree';
const artifactSha256 = process.env.MEDIA_SCOUT_ARTIFACT_SHA256 || 'unpacked working build';
const resultRoot = path.join(root, 'test-results', 'browser', slug(browserLabel));

if (!browserExecutable) throw new Error('Set MEDIA_SCOUT_BROWSER to the exact Chrome-compatible browser executable.');
if (!path.isAbsolute(browserExecutable)) throw new Error('MEDIA_SCOUT_BROWSER must be an absolute executable path.');
await readFile(path.join(extensionPath, 'manifest.json'));

const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'media-scout-e2e-'));
const fixture = await startFixtureServer();
await rm(resultRoot, { recursive: true, force: true });
await mkdir(resultRoot, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const accessibilityResults = {};
const startedAt = new Date().toISOString();
let context;

try {
  context = await chromium.launchPersistentContext(profileRoot, {
    executablePath: browserExecutable,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  context.on('page', attachDiagnostics);
  for (const page of context.pages()) attachDiagnostics(page);

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  }
  assert.ok(worker, `${browserLabel} did not load the unpacked extension service worker; the browser may reject command-line side-loading.`);
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/, 'extension ID has the expected unpacked-extension shape');

  const fixturePage = await context.newPage();
  const fixturePageOrigin = fixture.origin.replace('127.0.0.1', 'localhost');
  await fixturePage.goto(`${fixturePageOrigin}/`, { waitUntil: 'networkidle' });
  const scannerMetrics = await assertFixturePage(fixturePage);
  accessibilityResults.controlledFixture = scannerMetrics.accessibility;
  await fixturePage.screenshot({ path: path.join(resultRoot, 'controlled-fixture.png'), fullPage: true });

  const popupStarted = performance.now();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
  await popup.waitForSelector('#recommendationTitle');
  const coldPopupReadyMs = performance.now() - popupStarted;
  const warmPopupStarted = performance.now();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await popup.waitForSelector('#recommendationTitle');
  const warmPopupReadyMs = performance.now() - warmPopupStarted;
  accessibilityResults.popup = await assertNoBlockingAxeViolations(popup, 'popup');
  const popupKeyboard = await verifyPopupKeyboard(popup);
  await popup.screenshot({ path: path.join(resultRoot, 'popup.png'), fullPage: true });

  const sidepanel = await context.newPage();
  await sidepanel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  await sidepanel.waitForSelector('[data-route="reports"]');
  await sidepanel.locator('[data-route="reports"]').click();
  await sidepanel.waitForSelector('#reports:not(.hidden)');
  accessibilityResults.reportRoute = await assertNoBlockingAxeViolations(sidepanel, 'side panel reports route');
  await sidepanel.screenshot({ path: path.join(resultRoot, 'report-route.png'), fullPage: true });
  await sidepanel.locator('[data-route="inspector"]').click();
  const render500Ms = await measureCandidateRender(worker, sidepanel, 500, fixture.origin);
  await sidepanel.locator('[data-focus-key="inspector-filter"]').fill('controlled-49');
  await sidepanel.waitForFunction(() => document.activeElement?.dataset?.focusKey === 'inspector-filter');
  assert.equal(await sidepanel.evaluate(() => document.activeElement?.selectionStart), 'controlled-49'.length, 'Inspector filter restores focus and caret after dynamic rendering');
  await sidepanel.locator('[data-focus-key="inspector-filter"]').fill('');
  await sidepanel.waitForFunction(() => document.querySelectorAll('#inspector .candidate-card').length === 500);
  const render750Ms = await measureCandidateRender(worker, sidepanel, 750, fixture.origin);
  await sidepanel.locator('[data-focus-key="inspector-filter"]').fill('candidate=749');
  await sidepanel.waitForFunction(() => document.querySelectorAll('#inspector .candidate-card').length === 1);
  accessibilityResults.inspector = await assertNoBlockingAxeViolations(sidepanel, 'side panel Inspector route');
  const responsive = await verifyResponsiveAndMediaPreferences(sidepanel);
  const progressAccessibility = await verifyQueueProgress(worker, sidepanel);
  accessibilityResults.queue = await assertNoBlockingAxeViolations(sidepanel, 'side panel Queue route');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await options.waitForSelector('#save');
  const originalTemplate = await options.locator('#filenameTemplate').inputValue();
  await options.locator('#filenameTemplate').fill('گزارش-שלום-{indexSuffix}.{extension}');
  await options.waitForFunction(() => /گزارش-שלום/.test(document.querySelector('#filenameDryRun')?.textContent || ''));
  await options.locator('#filenameTemplate').fill(originalTemplate);
  const originalNotifications = await options.locator('#notifications').isChecked();
  await options.locator('#notifications').setChecked(!originalNotifications);
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#changeStateLabel')?.textContent?.includes('saved'));
  await options.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await options.locator('#notifications').isChecked(), !originalNotifications, 'settings persist across an options-page reload');
  await options.locator('#notifications').setChecked(originalNotifications);
  await options.locator('#save').click();
  accessibilityResults.settings = await assertNoBlockingAxeViolations(options, 'settings');
  await options.screenshot({ path: path.join(resultRoot, 'settings.png'), fullPage: true });

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('; ')}`);

  const browserVersion = await browserProductVersion(context, fixturePage);
  const manifestBytes = await readFile(path.join(extensionPath, 'manifest.json'));
  const fixtureManifestBytes = await readFile(path.join(root, 'test-fixtures', 'site', 'generated', 'FIXTURE_MANIFEST.json'));
  const performanceBudgets = {
    coldPopupReadyMs: 2000,
    warmPopupReadyMs: 1200,
    initialScanMs: 1500,
    pathologicalScanMs: 3000,
    render500Ms: 3000,
    render750Ms: 4500
  };
  const performanceMeasurements = {
    coldPopupReadyMs: round(coldPopupReadyMs),
    warmPopupReadyMs: round(warmPopupReadyMs),
    initialScanMs: round(scannerMetrics.initialScanMs),
    pathologicalScanMs: round(scannerMetrics.pathologicalScanMs),
    render500Ms: round(render500Ms),
    render750Ms: round(render750Ms)
  };
  const failedPerformanceBudgets = Object.entries(performanceBudgets)
    .filter(([name, budget]) => performanceMeasurements[name] > budget)
    .map(([name]) => name);
  assert.deepEqual(failedPerformanceBudgets, [], `browser performance budgets failed: ${failedPerformanceBudgets.join(', ')}`);
  const evidence = {
    schemaVersion: 1,
    result: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    browserLabel,
    browserExecutableVersion,
    browserEngineVersion: browserVersion,
    operatingSystem: `${os.type()} ${os.release()} ${os.arch()}`,
    candidateCommit,
    extensionVersion: JSON.parse(manifestBytes).version,
    extensionArtifactSha256: artifactSha256,
    extensionManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    fixtureManifestSha256: createHash('sha256').update(fixtureManifestBytes).digest('hex'),
    profileKind: 'disposable temporary directory',
    fixtureOriginKind: 'loopback-only controlled server',
    assertions: {
      extensionServiceWorkerLoaded: true,
      fixtureWorkflows: true,
      popupAxeBlockingViolations: 0,
      reportRouteAxeBlockingViolations: 0,
      settingsAxeBlockingViolations: 0,
      settingsPersistence: true,
      consoleErrors: 0,
      pageErrors: 0
    },
    accessibility: {
      axe: accessibilityResults,
      popupKeyboard,
      inspectorFocusRestored: true,
      rtlBidirectionalFilename: true,
      responsive,
      progress: progressAccessibility
    },
    performanceBudgets,
    performanceMeasurements
  };
  await writeFile(path.join(resultRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${browserLabel} browser E2E PASS on ${browserExecutableVersion} (${browserVersion}); evidence written to ${path.relative(root, resultRoot)}.`);
} finally {
  if (context) await context.close();
  await fixture.close();
  if (path.dirname(profileRoot) === os.tmpdir() && path.basename(profileRoot).startsWith('media-scout-e2e-')) {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

function attachDiagnostics(page) {
  if (page.__mediaScoutDiagnosticsAttached) return;
  page.__mediaScoutDiagnosticsAttached = true;
  page.on('console', (message) => {
    const expectedFixtureCorsFailure = page.url().startsWith('http://localhost:') && /net::ERR_FAILED/i.test(message.text());
    if (message.type() === 'error' && !expectedFixtureCorsFailure && !/favicon\.ico|cors\/media\.mp4|access-control-allow-origin|cors policy/i.test(message.text())) {
      consoleErrors.push(`${page.url()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
}

async function assertFixturePage(page) {
  assert.equal(await page.locator('h1').textContent(), 'Media Scout Fixture Library');
  await page.locator('#directVideo').evaluate((video) => video.load());
  await page.addScriptTag({ path: path.join(extensionPath, 'src', 'content', 'page-media-scanner.js') });
  const initialScanMs = await page.evaluate(async () => {
    const started = performance.now();
    await globalThis.MediaScoutPageScanner.scanDetailed();
    return performance.now() - started;
  });
  await page.locator('#blobButton').click();
  await page.waitForSelector('video[data-fixture="page-local-blob"]');
  await page.locator('[data-fetch="/fixtures/encrypted.m3u8"]').click();
  await page.waitForFunction(() => document.querySelector('#fixtureStatus')?.textContent?.includes('HTTP 200'));
  await page.locator('#corsButton').click();
  await page.waitForFunction(() => /blocked or failed/i.test(document.querySelector('#fixtureStatus')?.textContent || ''));
  await page.locator('#pathologicalButton').click();
  assert.equal(await page.locator('#pathologicalFixture > *').count(), 20000);
  const pathologicalScanMs = await page.evaluate(async () => {
    const started = performance.now();
    const result = await globalThis.MediaScoutPageScanner.scanDetailed();
    if (result.decisions.length > 360) throw new Error('Detailed decisions exceeded the structural cap.');
    return performance.now() - started;
  });
  await page.locator('#pathologicalFixture').evaluate((element) => element.remove());
  const accessibility = await assertNoBlockingAxeViolations(page, 'controlled fixture page');
  return { initialScanMs, pathologicalScanMs, accessibility };
}

async function measureCandidateRender(worker, sidepanel, count, fixtureOrigin) {
  const candidates = Array.from({ length: count }, (_value, index) => ({
    id: `browser-candidate-${index}`,
    tabId: 700,
    url: `${fixtureOrigin}/generated/scout-demo.mp4?candidate=${index}`,
    normalizedUrl: `${fixtureOrigin}/generated/scout-demo.mp4?candidate=${index}`,
    hostname: 'controlled.fixture',
    filename: index === 0 ? 'گزارش-مقطع-שלום.mp4' : `controlled-${index}.mp4`,
    mediaType: 'video',
    extension: 'mp4',
    mime: 'video/mp4',
    contentType: 'video/mp4',
    status: 'detected',
    isProtected: false,
    stale: false,
    detectedAt: '2026-08-17T12:00:00.000Z',
    detectionMethods: ['controlled-browser-performance']
  }));
  const started = performance.now();
  await worker.evaluate((message) => {
    globalThis.chrome.runtime.sendMessage(message).catch(() => undefined);
  }, { type: 'ACTIVE_TAB_STATE', tabId: null, mediaItems: candidates, replaceMediaItems: true });
  await sidepanel.waitForFunction((expected) => document.querySelectorAll('#inspector .candidate-card').length === expected, count, { timeout: 15000 });
  return performance.now() - started;
}

async function assertNoBlockingAxeViolations(page, label) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => globalThis.axe.run(document, {
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
  }));
  const blocking = result.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));
  assert.deepEqual(blocking.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length })), [], `${label} has blocking axe violations`);
  return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
}

async function verifyPopupKeyboard(page) {
  await page.bringToFront();
  await page.locator('#openHome').focus();
  const expected = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => button.offsetParent !== null && !button.disabled).map((button) => button.id).filter(Boolean));
  const sequence = ['openHome'];
  let primaryFocusStyle = null;
  for (let index = 1; index < expected.length; index += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => ({
      id: document.activeElement?.id || '',
      tag: document.activeElement?.tagName || '',
      outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
      outlineWidth: getComputedStyle(document.activeElement).outlineWidth
    }));
    sequence.push(focused.id || focused.tag);
    if (focused.id === 'primaryAction') primaryFocusStyle = `${focused.outlineStyle} ${focused.outlineWidth}`;
  }
  for (const required of expected) {
    assert.ok(sequence.includes(required), `popup keyboard order reaches ${required}`);
  }
  assert.match(primaryFocusStyle || '', /solid 3px/, 'popup primary action has a visible keyboard focus outline');
  return { expected, reached: sequence, primaryFocusStyle };
}

async function verifyResponsiveAndMediaPreferences(page) {
  const widths = [];
  for (const width of [360, 720]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${width}px side panel has no horizontal page clipping`);
    widths.push({ width, ...layout });
  }
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  const media = await page.evaluate(() => ({
    forcedColors: matchMedia('(forced-colors: active)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    transitionDuration: getComputedStyle(document.querySelector('button')).transitionDuration,
    transitionDurationSeconds: (() => {
      const value = getComputedStyle(document.querySelector('button')).transitionDuration;
      return value.endsWith('ms') ? Number.parseFloat(value) / 1000 : Number.parseFloat(value);
    })()
  }));
  assert.equal(media.forcedColors, true, 'forced-colors media query activates');
  assert.equal(media.reducedMotion, true, 'reduced-motion media query activates');
  assert.ok(media.transitionDurationSeconds <= 0.00001, 'reduced-motion rule collapses button transition duration');
  await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const zoom = await page.evaluate(() => ({
    zoom: getComputedStyle(document.documentElement).zoom,
    primaryControlsVisible: Array.from(document.querySelectorAll('button')).filter((button) => button.offsetParent !== null).every((button) => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0)
  }));
  assert.equal(zoom.zoom, '2', '200% CSS zoom test is active');
  assert.equal(zoom.primaryControlsVisible, true, 'visible controls retain measurable boxes at 200% zoom');
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  return { widths, media, zoom };
}

async function verifyQueueProgress(worker, sidepanel) {
  await worker.evaluate((message) => {
    globalThis.chrome.runtime.sendMessage(message).catch(() => undefined);
  }, {
    type: 'QUEUE_UPDATED',
    state: {
      paused: false,
      pending: [],
      active: [{
        id: 'controlled-progress',
        displayName: 'Controlled progress fixture',
        status: 'active',
        progress: { percent: 42, loaded: 42, total: 100, detail: 'Controlled browser handoff' }
      }],
      completed: [],
      failed: [],
      canceled: []
    }
  });
  await sidepanel.locator('[data-route="queue"]').click();
  const progress = sidepanel.locator('[role="progressbar"]');
  await progress.waitFor();
  const attributes = await progress.evaluate((element) => ({
    label: element.getAttribute('aria-label'),
    valueNow: element.getAttribute('aria-valuenow'),
    valueText: element.getAttribute('aria-valuetext')
  }));
  assert.match(attributes.label || '', /Controlled progress fixture/);
  assert.equal(attributes.valueNow, '42');
  assert.equal(attributes.valueText, '42 percent');
  return attributes;
}

async function browserProductVersion(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const info = await session.send('Browser.getVersion');
    return info.product;
  } finally {
    await session.detach();
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'browser';
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
