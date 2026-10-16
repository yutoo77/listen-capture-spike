'use strict';

// Desktop Chromium regression checks. All microphone input is Chromium's fake
// device. This suite never requests the computer's physical microphone.
// Run: node tests/browser-regression.cjs
// If Playwright is not resolvable, set PLAYWRIGHT_MODULE to its package path.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function loadPlaywright() {
  const choices = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  for (const candidate of choices) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Playwright is required. Set PLAYWRIGHT_MODULE to the installed package.');
}

const root = path.resolve(__dirname, '..');
const prefix = '/project-preview/';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml' };

function createServer() {
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const relative = pathname.slice(prefix.length) || 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end(); return;
    }
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    }
  });
}

async function dbMemos(page) {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const selected = databases.find(database => database.name?.startsWith('listen-capture'));
    if (!selected) throw new Error('No Listen / Capture database exists');
    return new Promise((resolve, reject) => {
    const request = indexedDB.open(selected.name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('memos', 'readonly');
      const get = tx.objectStore('memos').getAll();
      get.onsuccess = () => resolve(get.result.map(({ blob, ...memo }) => ({ ...memo,
        blobSize: blob?.size || 0, blobType: blob?.type || null })));
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error);
    };
    });
  });
}

async function waitForCount(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('#memos .memo').length === expected, count);
}
async function open(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#player').readyState >= 1);
  await page.waitForFunction(() => !document.querySelector('#recordToggle').disabled);
}
async function seekTo(page, second) {
  await page.locator('#player').evaluate((audio, target) => { audio.currentTime = target; }, second);
  await page.waitForFunction(target => Math.abs(document.querySelector('#player').currentTime - target) < 0.2, second);
}
async function record(page) {
  await page.locator('#recordToggle').click();
  await page.waitForFunction(() => document.querySelector('#recordToggle').classList.contains('recording'));
  await page.waitForTimeout(1300); // produce actual encoded fake-device audio
}
async function stopRecording(page, expectedCount = 1) {
  await page.locator('#recordToggle').click();
  await waitForCount(page, expectedCount);
  await page.waitForFunction(() => !document.querySelector('#recordToggle').disabled &&
    !document.querySelector('#recordToggle').classList.contains('recording'));
}

async function readDownload(download) {
  const stream = await download.createReadStream();
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

async function main() {
  const { chromium } = loadPlaywright();
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  const browser = await chromium.launch({ headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const browserVersion = browser.version();
  const results = [];
  const browserErrors = [];
  const unexpectedRequests = [];

  async function test(name, fn, options = {}) {
    const context = await browser.newContext({ acceptDownloads: true,
      ...(options.denied ? {} : { permissions: ['microphone'] }) });
    await context.addInitScript(() => {
      window.__testMediaStreams = [];
      const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
      if (original) navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.__testMediaStreams.push(stream);
        return stream;
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(9000);
    page.on('pageerror', error => browserErrors.push({ test: name, message: error.message }));
    page.on('request', request => {
      const target = request.url();
      if (!target.startsWith(url) && !/^(blob:|data:)/.test(target)) unexpectedRequests.push({ test: name, url: target });
    });
    const started = Date.now();
    try {
      await fn(page, context);
      results.push({ name, status: 'passed', milliseconds: Date.now() - started });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: 'failed', message: error.message, milliseconds: Date.now() - started });
      console.log(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); }
  }

  try {
    await test('subpath load, assets, actual playback, pause and rewind', async page => {
      await open(page, url);
      assert.match(await page.title(), /Listen \/ Capture/);
      for (const resource of ['app.js', 'styles.css', 'manifest.webmanifest', 'assets/sample.mp3', 'assets/icon-192.png']) {
        const response = await page.request.get(url + resource);
        assert.equal(response.status(), 200, resource);
        assert.ok((await response.body()).length > 0, resource);
      }
      await page.locator('#playToggle').click();
      await page.waitForFunction(() => !document.querySelector('#player').paused && document.querySelector('#player').currentTime > 0.3);
      await page.locator('#playToggle').click();
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      await seekTo(page, 15);
      await page.locator('#rewind').click();
      assert.ok(Math.abs(await page.locator('#player').evaluate(audio => audio.currentTime) - 5) < 0.2);
    });

    await test('bookmark reference, reload durability, seek and deletion', async page => {
      await open(page, url);
      await seekTo(page, 9);
      await page.locator('#bookmark').click();
      await waitForCount(page, 1);
      let [memo] = await dbMemos(page);
      assert.equal(memo.kind, 'bookmark');
      assert.ok(Math.abs(memo.offsetSec - 7) < 0.2);
      await page.reload({ waitUntil: 'networkidle' });
      await waitForCount(page, 1);
      await seekTo(page, 1);
      await page.locator('#memos .memo').getByRole('button', { name: '元の位置へ戻る' }).click();
      assert.ok(Math.abs(await page.locator('#player').evaluate(audio => audio.currentTime) - memo.offsetSec) < 0.2);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#memos .memo').getByRole('button', { name: '削除', exact: true }).click();
      await waitForCount(page, 0);
      assert.equal((await dbMemos(page)).length, 0);
    });

    await test('fake microphone save, resume, memo playback, download and reload', async page => {
      await open(page, url);
      await seekTo(page, 8);
      await page.locator('#playToggle').click();
      await record(page);
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      await stopRecording(page);
      const [memo] = await dbMemos(page);
      assert.equal(memo.kind, 'voice');
      assert.ok(memo.blobSize > 0);
      assert.ok(memo.offsetSec >= 8 && memo.offsetSec < 11);
      assert.equal(await page.evaluate(() => window.__testMediaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
      await page.waitForFunction(() => !document.querySelector('#player').paused);
      await page.locator('#playToggle').click();
      const voice = page.locator('#memos .memo audio');
      await voice.evaluate(audio => audio.play());
      await page.waitForFunction(() => document.querySelector('#memos .memo audio').currentTime > 0.1);
      await voice.evaluate(audio => audio.pause());
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#memos .memo').getByRole('link', { name: '録音を保存' }).click();
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(), /^voice-memo-.*\.(m4a|webm|ogg|bin)$/);
      assert.equal(await download.failure(), null);
      assert.equal((await readDownload(download)).length, memo.blobSize);
      await page.reload({ waitUntil: 'networkidle' });
      await waitForCount(page, 1);
      const [reloaded] = await dbMemos(page);
      assert.equal(reloaded.blobSize, memo.blobSize);
      assert.equal(reloaded.offsetSec, memo.offsetSec);
      await page.locator('#memos .memo').getByRole('button', { name: '元の位置へ戻る' }).click();
      assert.ok(Math.abs(await page.locator('#player').evaluate(audio => audio.currentTime) - memo.offsetSec) < 0.2);
    });

    await test('recording from a paused source does not force source playback', async page => {
      await open(page, url);
      await seekTo(page, 4);
      await record(page);
      await stopRecording(page);
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      const [memo] = await dbMemos(page);
      assert.ok(Math.abs(memo.offsetSec - 4) < 0.2);
    });

    await test('automatic resume rejection leaves saved memo and supports explicit playback', async page => {
      await open(page, url);
      await page.locator('#playToggle').click();
      await record(page);
      await page.evaluate(() => {
        const original = HTMLMediaElement.prototype.play;
        let rejectOnce = true;
        HTMLMediaElement.prototype.play = function(...args) {
          if (this.id === 'player' && rejectOnce) {
            rejectOnce = false;
            return Promise.reject(new DOMException('Synthetic autoplay policy rejection', 'NotAllowedError'));
          }
          return original.apply(this, args);
        };
      });
      await stopRecording(page);
      await page.waitForFunction(() => document.querySelector('#status').classList.contains('warning'));
      assert.equal((await dbMemos(page)).length, 1);
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      await page.locator('#playToggle').click();
      await page.waitForFunction(() => !document.querySelector('#player').paused);
    });

    await test('microphone permission denial preserves source reference and permits retry', async page => {
      await contextDenyMic(page);
      await open(page, url);
      await seekTo(page, 6);
      await page.locator('#playToggle').click();
      await page.locator('#recordToggle').click();
      await page.waitForFunction(() => document.querySelector('#status').classList.contains('warning'));
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      assert.equal(await page.locator('#recordToggle').isEnabled(), true);
      assert.equal((await dbMemos(page)).length, 0);
      assert.match(await page.locator('#status').innerText(), /許可|NotAllowedError/);
    });

    await test('source playback cannot start while microphone recording is active', async page => {
      await open(page, url);
      await record(page);
      if (await page.locator('#playToggle').isEnabled()) await page.locator('#playToggle').click();
      await page.waitForTimeout(150);
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true,
        'source playback during capture may leak into the recorded memo');
      await stopRecording(page);
    });

    await test('microphone track ending exits capture and preserves collected audio', async page => {
      await open(page, url);
      await record(page);
      await page.evaluate(() => {
        for (const stream of window.__testMediaStreams) for (const track of stream.getTracks()) {
          track.stop();
          track.dispatchEvent(new Event('ended'));
        }
      });
      await page.waitForFunction(() => !document.querySelector('#recordToggle').classList.contains('recording'), null, { timeout: 5000 });
      await waitForCount(page, 1);
      assert.ok((await dbMemos(page))[0].blobSize > 0);
    });

    await test('saved recording with failed list rendering remains truthfully saved', async page => {
      await open(page, url);
      await page.evaluate(() => {
        const list = document.querySelector('#memos');
        list.replaceChildren = () => { throw new Error('Synthetic list rendering failure'); };
      });
      await record(page);
      await page.locator('#recordToggle').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('保存済み') &&
        document.querySelector('#status').textContent.includes('一覧') &&
        !document.querySelector('#recordToggle').disabled);
      const saved = await dbMemos(page);
      assert.equal(saved.length, 1);
      assert.ok(saved[0].blobSize > 0);
      assert.equal(await page.locator('#unsavedRecordings').isVisible(), false);
      assert.equal(await page.locator('a[download^="unsaved-recording"]').count(), 0);
      await page.reload({ waitUntil: 'networkidle' });
      await waitForCount(page, 1);
      assert.equal((await dbMemos(page))[0].blobSize, saved[0].blobSize);
    });

    await test('cancelled pending microphone request releases late stream and permits next capture', async page => {
      await open(page, url);
      await page.evaluate(() => {
        const original = navigator.mediaDevices.getUserMedia;
        window.__testOriginalGetUserMedia = original;
        navigator.mediaDevices.getUserMedia = constraints => new Promise((resolve, reject) => {
          window.__testResolvePendingMicrophone = async () => {
            try { resolve(await original(constraints)); } catch (error) { reject(error); }
          };
        });
      });
      await page.locator('#recordToggle').click();
      await page.waitForFunction(() => !document.querySelector('#cancelStart').hidden);
      await page.locator('#cancelStart').click();
      assert.equal(await page.locator('#recordToggle').isEnabled(), true);
      await page.evaluate(async () => {
        await window.__testResolvePendingMicrophone();
        navigator.mediaDevices.getUserMedia = window.__testOriginalGetUserMedia;
      });
      await page.waitForFunction(() => window.__testMediaStreams.length > 0 &&
        window.__testMediaStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
      assert.equal((await dbMemos(page)).length, 0);
      assert.equal(await page.locator('#playToggle').isEnabled(), true);
      assert.equal(await page.locator('#recordToggle').getAttribute('aria-pressed'), 'false');
      await record(page);
      await stopRecording(page);
      assert.equal((await dbMemos(page)).length, 1);
    });

    await test('recording time limit saves one interrupted memo and never auto resumes', async page => {
      await page.addInitScript(() => {
        const original = window.setTimeout;
        window.setTimeout = function(callback, delay, ...args) {
          return original.call(this, callback, delay === 60000 ? 2000 : delay, ...args);
        };
      });
      await open(page, url);
      await page.locator('#playToggle').click();
      await record(page);
      await waitForCount(page, 1);
      await page.waitForFunction(() => !document.querySelector('#recordToggle').disabled &&
        document.querySelector('#recordToggle').getAttribute('aria-pressed') === 'false');
      const [memo] = await dbMemos(page);
      assert.ok(memo.blobSize > 0);
      assert.equal(memo.interrupted, true);
      assert.equal(memo.stopReason, 'time-limit');
      assert.equal(memo.incomplete, false);
      assert.equal(await page.locator('#player').evaluate(audio => audio.paused), true);
      assert.equal(await page.evaluate(() => window.__testMediaStreams.every(stream =>
        stream.getTracks().every(track => track.readyState === 'ended'))), true);
      assert.match(await page.locator('#status').innerText(), /中断/);
      await page.waitForTimeout(200);
      assert.equal((await dbMemos(page)).length, 1);
    });

    await test('storage failure retains an unsaved download despite later status changes', async page => {
      await open(page, url);
      await page.evaluate(() => {
        window.__testOriginalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, ...args) {
          if (this.name === 'memos' && value.kind === 'voice') throw new DOMException('Synthetic quota test', 'QuotaExceededError');
          return window.__testOriginalPut.call(this, value, ...args);
        };
      });
      await record(page);
      await page.locator('#recordToggle').click();
      await page.waitForFunction(() => !!document.querySelector('a[download^="unsaved-recording"]'));
      assert.equal((await dbMemos(page)).length, 0);
      const first = page.locator('a[download^="unsaved-recording"]');
      const downloadPromise = page.waitForEvent('download');
      await first.click();
      const download = await downloadPromise;
      assert.ok((await readDownload(download)).length > 0);
      await page.locator('#playToggle').click();
      assert.equal(await first.count(), 1, 'unsaved audio must not disappear when playback updates the status');
      await page.locator('#playToggle').click();
      await record(page);
      await page.locator('#recordToggle').click();
      await page.waitForFunction(() => document.querySelectorAll('a[download^="unsaved-recording"]').length === 2);
      assert.equal((await dbMemos(page)).length, 0);
      await page.evaluate(() => { IDBObjectStore.prototype.put = window.__testOriginalPut; });
      await page.locator('#unsavedRecordings button[data-action="retry"]').first().click();
      await waitForCount(page, 1);
      await page.waitForFunction(() => document.querySelectorAll('a[download^="unsaved-recording"]').length === 1);
      await page.locator('#unsavedRecordings button[data-action="retry"]').first().click();
      await waitForCount(page, 2);
      await page.waitForFunction(() => !document.querySelector('a[download^="unsaved-recording"]'));
      assert.ok((await dbMemos(page)).every(memo => memo.blobSize > 0));
    });

    await test('same-named different local files cannot share a source reference', async page => {
      await open(page, url);
      const source = fs.readFileSync(path.join(root, 'assets/sample.mp3'));
      await page.locator('#audioFile').setInputFiles({ name: 'lecture.mp3', mimeType: 'audio/mpeg', buffer: source });
      await page.waitForFunction(() => document.querySelector('#player').readyState >= 1);
      await seekTo(page, 8);
      await page.locator('#bookmark').click();
      await waitForCount(page, 1);
      const altered = Buffer.concat([source, Buffer.from('different source file')]);
      await page.locator('#audioFile').setInputFiles({ name: 'lecture.mp3', mimeType: 'audio/mpeg', buffer: altered });
      await page.waitForFunction(() => document.querySelector('#player').readyState >= 1);
      await page.locator('#memos .memo').getByRole('button', { name: '元の位置へ戻る' }).click();
      assert.ok(await page.locator('#player').evaluate(audio => audio.currentTime < 0.2),
        'different files sharing a filename must not be treated as the same source');
      assert.match(await page.locator('#status').innerText(), /選び直|一致|元の|異な/);
      await page.locator('#audioFile').setInputFiles({ name: 'lecture.mp3', mimeType: 'audio/mpeg', buffer: source });
      await page.waitForFunction(() => document.querySelector('#player').readyState >= 1);
      await page.locator('#memos .memo').getByRole('button', { name: '元の位置へ戻る' }).click();
      assert.ok(Math.abs(await page.locator('#player').evaluate(audio => audio.currentTime) - 6) < 0.2,
        'reselecting the original bytes should restore the stored reference');
    });

    await test('source and memo playback are mutually exclusive', async page => {
      await open(page, url);
      await record(page);
      await stopRecording(page);
      await page.locator('#playToggle').click();
      await page.waitForFunction(() => !document.querySelector('#player').paused);
      await page.locator('#memos .memo audio').evaluate(audio => audio.play());
      await page.waitForFunction(() => document.querySelector('#player').paused &&
        !document.querySelector('#memos .memo audio').paused);
      await page.locator('#playToggle').click();
      await page.waitForFunction(() => !document.querySelector('#player').paused &&
        document.querySelector('#memos .memo audio').paused);
    });

    await test('diagnostic export contains no audio payload or selected filename', async page => {
      await open(page, url);
      const sensitiveName = 'PRIVATE-SYNTHETIC-LECTURE-TITLE.mp3';
      await page.locator('#audioFile').setInputFiles({ name: sensitiveName, mimeType: 'audio/mpeg',
        buffer: fs.readFileSync(path.join(root, 'assets/sample.mp3')) });
      await record(page);
      await stopRecording(page);
      await page.locator('details.diagnostics').evaluate(element => { element.open = true; });
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#exportLog').click();
      const download = await downloadPromise;
      const content = (await readDownload(download)).toString('utf8');
      const log = JSON.parse(content);
      assert.ok(log.events.length > 0);
      assert.ok(!content.includes(sensitiveName));
      assert.ok(!content.includes('data:audio'));
      assert.ok(!content.includes('blob:'));
    });

    await test('desktop and mobile layouts fit viewport with screenshots', async page => {
      const artifactDirectory = path.join(root, 'artifacts', 'test-results');
      fs.mkdirSync(artifactDirectory, { recursive: true });
      for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        await page.setViewportSize(viewport);
        await open(page, url);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
          `${label} page overflows horizontally`);
        await page.screenshot({ path: path.join(artifactDirectory, `${label}.png`), fullPage: true });
      }
    });
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }

  const report = { environment: 'Desktop Chromium; synthetic fake microphone; localhost secure context; no iPhone or physical microphone validation',
    browserVersion,
    appSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'app.js'))).digest('hex'),
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    browserErrors, unexpectedRequests, results };
  const reportDirectory = path.join(root, 'artifacts', 'test-results');
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(reportDirectory, 'browser-regression-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.failed || browserErrors.length || unexpectedRequests.length) process.exitCode = 1;
}

async function contextDenyMic(page) {
  // Deterministic permission rejection without ever touching a physical device.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic permission denial', 'NotAllowedError'); };
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
