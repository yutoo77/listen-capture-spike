'use strict';

// Read-only verification of a real public deployment. No microphone or user data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

async function main() {
  const base = new URL(process.argv[2]);
  assert.equal(base.protocol, 'https:', 'Use the actual HTTPS deployment URL');
  const root = path.resolve(__dirname, '..');
  const files = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest',
    'assets/sample.mp3', 'assets/sample-script.txt', 'assets/icon-192.png', 'assets/icon-512.png'];
  const results = [];
  for (const name of files) {
    const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `${name} must be public and return 200`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = execFileSync('git', ['show', `HEAD:${name}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    assert.deepEqual(bytes, expected, `${name} must match the committed source`);
    results.push({ name, status: response.status, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const range = await fetch(new URL('assets/sample.mp3', base), {
    headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(30_000)
  });
  assert.equal(range.status, 206, 'Audio must support byte-range requests');
  assert.equal((await range.arrayBuffer()).byteLength, 1024);
  assert.match(range.headers.get('content-range'), /^bytes 0-1023\/\d+$/);
  console.log(JSON.stringify({ url: base.href, verifiedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    assets: results, audioRange: { status: range.status, contentRange: range.headers.get('content-range') },
    limits: 'HTTPS and asset verification only; no iPhone, lock screen, Bluetooth, or microphone validation.' }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
