// Smoke test: boots the real server against a temp library and exercises the main API paths.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-uploader-'));
const lib = path.join(tmp, 'library');
const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${PORT}/api`;
let server;

const call = async (p, { method = 'GET', body, raw } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root, env: { ...process.env, PORT, LIBRARY_DIR: lib, DATA_DIR: path.join(tmp, 'data') }, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('running') && resolve());
    server.on('exit', (c) => reject(new Error('server exited early: ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
});

after(async () => {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited; // Windows keeps the SQLite files locked until the process is gone
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('folders are created on disk and renamed on disk', async () => {
  const a = await call('/folders', { method: 'POST', body: { parentId: 1, name: 'Finance' } });
  assert.equal(a.status, 201);
  assert.ok(fs.statSync(path.join(lib, 'Finance')).isDirectory());
  const r = await call(`/folders/${a.data.id}`, { method: 'PATCH', body: { name: 'Finance Docs' } });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(lib, 'Finance Docs')));
  assert.ok(!fs.existsSync(path.join(lib, 'Finance')));
});

test('upload stores the file on disk with name, size, type and date', async () => {
  const folderId = (await call('/folders')).data.find((f) => f.name === 'Finance Docs').id;
  const up = await call(`/files?folderId=${folderId}&name=report.pdf`, { method: 'PUT', raw: 'hello' });
  assert.equal(up.status, 201);
  assert.equal(up.data.name, 'report.pdf');
  assert.equal(up.data.size, 5);
  assert.equal(up.data.ext, 'pdf');
  assert.ok(!Number.isNaN(Date.parse(up.data.uploadedAt)));
  assert.equal(fs.readFileSync(path.join(lib, 'Finance Docs', 'report.pdf'), 'utf8'), 'hello');
});

test('duplicate upload names get a numeric suffix instead of overwriting', async () => {
  const folderId = (await call('/folders')).data.find((f) => f.name === 'Finance Docs').id;
  const up = await call(`/files?folderId=${folderId}&name=report.pdf`, { method: 'PUT', raw: 'second' });
  assert.equal(up.data.name, 'report (1).pdf');
});

test('unsafe names are neutralised and cannot escape the library', async () => {
  const r = await call('/folders', { method: 'POST', body: { parentId: 1, name: '../evil' } });
  assert.equal(r.data.name, '_evil');
  assert.ok(fs.existsSync(path.join(lib, '_evil')));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil')));
});

test('non-empty folders cannot be deleted', async () => {
  const folderId = (await call('/folders')).data.find((f) => f.name === 'Finance Docs').id;
  assert.equal((await call(`/folders/${folderId}`, { method: 'DELETE' })).status, 409);
});

test('rescan picks up files added outside the app and drops deleted ones', async () => {
  fs.writeFileSync(path.join(lib, 'dropped-in.txt'), 'x');
  fs.rmSync(path.join(lib, 'Finance Docs', 'report (1).pdf'));
  const s = await call('/rescan', { method: 'POST' });
  assert.equal(s.data.addedFiles, 1);
  assert.equal(s.data.removedFiles, 1);
});

test('requests with a foreign Origin are rejected', async () => {
  const res = await fetch(base + '/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(res.status, 403);
});
