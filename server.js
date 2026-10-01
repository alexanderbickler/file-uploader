// Document Library — local server.
// Files live as real files in real folders under LIBRARY_DIR; SQLite (data/library.db) indexes them.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// ---------- config ----------
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const LAN = process.env.LAN === '1'; // expose to other devices on the network (phone)
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const LIB = path.resolve(process.env.LIBRARY_DIR || path.join(ROOT, 'library'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PUBLIC = path.join(ROOT, 'public');
const TMP = path.join(LIB, '.tmp'); // same volume as the library so the final rename is atomic
const MAX_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 2048) * 1024 * 1024;

fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(TMP, { recursive: true, force: true }); // leftovers from interrupted uploads

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA, 'library.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY,
    parent_id  INTEGER REFERENCES folders(id),
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    UNIQUE (parent_id, name)
  );
  CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY,
    folder_id   INTEGER NOT NULL REFERENCES folders(id),
    name        TEXT NOT NULL COLLATE NOCASE,
    ext         TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    UNIQUE (folder_id, name)
  );
  INSERT OR IGNORE INTO folders (id, parent_id, name, created_at) VALUES (1, NULL, '', '${new Date().toISOString()}');
`);

const now = () => new Date().toISOString();
const qFolder = db.prepare('SELECT * FROM folders WHERE id = ?');
const qFile = db.prepare('SELECT * FROM files WHERE id = ?');
const qFolderByName = db.prepare('SELECT id FROM folders WHERE parent_id = ? AND name = ?');
const qFileByName = db.prepare('SELECT id, size FROM files WHERE folder_id = ? AND name = ?');
const insFolder = db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)');
const insFile = db.prepare('INSERT INTO files (folder_id, name, ext, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)');

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const MIME = {
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  json: 'application/json', md: 'text/markdown; charset=utf-8', rtf: 'application/rtf',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
};
const INLINE_OK = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt']); // safe to render in-browser
const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function cleanName(raw) {
  let n = String(raw ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '');
  if (n.length > 200) { const e = path.extname(n).slice(0, 20); n = n.slice(0, 200 - e.length) + e; }
  n = n.replace(/[. ]+$/, '');
  if (!n) throw new HttpError(400, 'Name is empty or invalid');
  if (RESERVED.test(n)) n = '_' + n;
  return n;
}

function folderParts(id) {
  const parts = [];
  let f = qFolder.get(id);
  if (!f) throw new HttpError(404, 'Folder not found');
  while (f && f.parent_id !== null) { parts.unshift(f.name); f = qFolder.get(f.parent_id); }
  return parts;
}
const folderAbs = (id) => path.join(LIB, ...folderParts(id));

function isDescendant(folderId, ancestorId) {
  let f = qFolder.get(folderId);
  while (f) { if (f.id === ancestorId) return true; f = f.parent_id === null ? null : qFolder.get(f.parent_id); }
  return false;
}

function uniqueName(folderId, name) {
  const dir = folderAbs(folderId);
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let n = name, i = 1;
  while (qFileByName.get(folderId, n) || fs.existsSync(path.join(dir, n))) n = `${stem} (${i++})${ext}`;
  return n;
}

function fsError(e) {
  if (e instanceof HttpError) return e;
  if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')
    return new HttpError(409, 'Windows says it is in use — close it in Explorer/other programs and retry');
  if (e.code === 'ENOENT') return new HttpError(404, 'Not found on disk — try Rescan');
  if (e.code === 'ENOSPC') return new HttpError(507, 'Disk is full');
  return e;
}

const json = (res, status, body) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
};

async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1e6) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// ---------- rescan: reconcile database with what is actually on disk ----------
function rescan() {
  const stats = { addedFolders: 0, addedFiles: 0, removedFolders: 0, removedFiles: 0 };
  const dropTree = (folderId) => {
    for (const c of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(folderId)) dropTree(c.id);
    stats.removedFiles += Number(db.prepare('DELETE FROM files WHERE folder_id = ?').run(folderId).changes);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    stats.removedFolders++;
  };
  const walk = (folderId, abs) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const seenDirs = new Set(), seenFiles = new Set();
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        let row = qFolderByName.get(folderId, e.name);
        if (!row) { row = { id: Number(insFolder.run(folderId, e.name, now()).lastInsertRowid) }; stats.addedFolders++; }
        seenDirs.add(row.id);
        walk(row.id, full);
      } else if (e.isFile()) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        let row = qFileByName.get(folderId, e.name);
        if (!row) {
          const ext = extOf(e.name);
          row = { id: Number(insFile.run(folderId, e.name, ext, mimeFor(ext), st.size, (st.birthtime > st.mtime ? st.mtime : st.birthtime).toISOString()).lastInsertRowid) };
          stats.addedFiles++;
        } else if (row.size !== st.size) {
          db.prepare('UPDATE files SET size = ? WHERE id = ?').run(st.size, row.id);
        }
        seenFiles.add(row.id);
      }
    }
    for (const r of db.prepare('SELECT id FROM files WHERE folder_id = ?').all(folderId))
      if (!seenFiles.has(r.id)) { db.prepare('DELETE FROM files WHERE id = ?').run(r.id); stats.removedFiles++; }
    for (const r of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(folderId))
      if (!seenDirs.has(r.id)) dropTree(r.id);
  };
  db.exec('BEGIN');
  try { walk(1, LIB); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return stats;
}

// ---------- request guards ----------
function guard(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!LAN && !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) throw new HttpError(403, 'Forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) { let o; try { o = new URL(origin).host; } catch { o = ''; } if (o !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked'); }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked');
  }
}

// ---------- API handlers ----------
async function upload(req, res, url) {
  const folderId = Number(url.searchParams.get('folderId'));
  const base = cleanName(url.searchParams.get('name'));
  const len = Number(req.headers['content-length']);
  if (len > MAX_BYTES) { res.setHeader('Connection', 'close'); throw new HttpError(413, `File exceeds the ${MAX_BYTES / 1048576} MB limit`); }
  folderParts(folderId); // 404 if the folder is unknown

  await fsp.mkdir(TMP, { recursive: true });
  const tmp = path.join(TMP, crypto.randomUUID());
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      received > MAX_BYTES ? cb(new HttpError(413, 'File too large')) : cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp, { flags: 'wx' }));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw fsError(e instanceof HttpError ? e : new HttpError(400, 'Upload interrupted'));
  }

  // synchronous from here: pick a free name, move into place, index it
  const dir = folderAbs(folderId);
  const name = uniqueName(folderId, base);
  try {
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) { fs.rmSync(tmp, { force: true }); throw fsError(e); }
  const ext = extOf(name);
  const id = Number(insFile.run(folderId, name, ext, mimeFor(ext), received, now()).lastInsertRowid);
  json(res, 201, { ...fileDto(qFile.get(id)), renamed: name !== base });
}

const fileDto = (f, pathCache) => {
  let p = pathCache?.get(f.folder_id);
  if (p === undefined) { p = folderParts(f.folder_id).join('/'); pathCache?.set(f.folder_id, p); }
  return { id: f.id, folderId: f.folder_id, name: f.name, ext: f.ext, mime: f.mime, size: f.size, uploadedAt: f.uploaded_at, path: p };
};

function listFiles(res, url) {
  const sorts = { name: 'name', ext: 'ext', size: 'size', uploaded_at: 'uploaded_at' };
  const col = sorts[url.searchParams.get('sort')] || 'uploaded_at';
  const dir = url.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const q = (url.searchParams.get('q') || '').trim();
  let rows;
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    rows = db.prepare(`SELECT * FROM files WHERE name LIKE ? ESCAPE '\\' ORDER BY ${col} ${dir}, name`).all(like);
  } else {
    rows = db.prepare(`SELECT * FROM files WHERE folder_id = ? ORDER BY ${col} ${dir}, name`).all(Number(url.searchParams.get('folderId')) || 1);
  }
  const cache = new Map();
  json(res, 200, rows.map((r) => fileDto(r, cache)));
}

function listFolders(res) {
  const rows = db.prepare(`SELECT f.id, f.parent_id AS parentId, f.name,
      (SELECT COUNT(*) FROM files WHERE folder_id = f.id) AS fileCount FROM folders f ORDER BY f.name`).all();
  json(res, 200, rows);
}

function createFolder(res, body) {
  const parentId = Number(body.parentId) || 1;
  const name = cleanName(body.name);
  const parentAbs = folderAbs(parentId);
  if (qFolderByName.get(parentId, name) || fs.existsSync(path.join(parentAbs, name))) throw new HttpError(409, 'A folder or file with that name already exists here');
  fs.mkdirSync(path.join(parentAbs, name));
  const id = Number(insFolder.run(parentId, name, now()).lastInsertRowid);
  json(res, 201, { id, parentId, name });
}

function patchFolder(res, id, body) {
  const f = qFolder.get(id);
  if (!f) throw new HttpError(404, 'Folder not found');
  if (f.parent_id === null) throw new HttpError(400, 'The library root cannot be changed');
  const name = body.name !== undefined ? cleanName(body.name) : f.name;
  const parentId = body.parentId !== undefined ? Number(body.parentId) : f.parent_id;
  if (!qFolder.get(parentId)) throw new HttpError(404, 'Destination folder not found');
  if (isDescendant(parentId, id)) throw new HttpError(400, 'A folder cannot be moved into itself');
  const sameSlot = parentId === f.parent_id && name.toLowerCase() === f.name.toLowerCase();
  const from = folderAbs(id), toDir = folderAbs(parentId), to = path.join(toDir, name);
  if (!sameSlot) {
    if (qFolderByName.get(parentId, name) || fs.existsSync(to)) throw new HttpError(409, 'A folder or file with that name already exists in the destination');
  }
  if (from !== to) fs.renameSync(from, to);
  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, id);
  json(res, 200, { id, parentId, name });
}

function deleteFolder(res, id) {
  const f = qFolder.get(id);
  if (!f) throw new HttpError(404, 'Folder not found');
  if (f.parent_id === null) throw new HttpError(400, 'The library root cannot be deleted');
  const kids = db.prepare('SELECT (SELECT COUNT(*) FROM folders WHERE parent_id = ?) + (SELECT COUNT(*) FROM files WHERE folder_id = ?) AS n').get(id, id).n;
  if (kids) throw new HttpError(409, 'Folder is not empty — move or delete its contents first');
  const abs = folderAbs(id);
  try { fs.rmdirSync(abs); } catch (e) { if (e.code === 'ENOTEMPTY') throw new HttpError(409, 'Folder contains files not in the library — run Rescan first'); if (e.code !== 'ENOENT') throw fsError(e); }
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  json(res, 200, { ok: true, parentId: f.parent_id });
}

function patchFile(res, id, body) {
  const f = qFile.get(id);
  if (!f) throw new HttpError(404, 'File not found');
  const name = body.name !== undefined ? cleanName(body.name) : f.name;
  const folderId = body.folderId !== undefined ? Number(body.folderId) : f.folder_id;
  const from = path.join(folderAbs(f.folder_id), f.name);
  const to = path.join(folderAbs(folderId), name);
  const sameSlot = folderId === f.folder_id && name.toLowerCase() === f.name.toLowerCase();
  if (!sameSlot && (qFileByName.get(folderId, name) || fs.existsSync(to))) throw new HttpError(409, 'A file with that name already exists in the destination');
  if (from !== to) fs.renameSync(from, to);
  const ext = extOf(name);
  db.prepare('UPDATE files SET name = ?, folder_id = ?, ext = ?, mime = ? WHERE id = ?').run(name, folderId, ext, mimeFor(ext), id);
  json(res, 200, fileDto(qFile.get(id)));
}

function deleteFile(res, id) {
  const f = qFile.get(id);
  if (!f) throw new HttpError(404, 'File not found');
  try { fs.unlinkSync(path.join(folderAbs(f.folder_id), f.name)); } catch (e) { if (e.code !== 'ENOENT') throw fsError(e); }
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  json(res, 200, { ok: true });
}

function download(req, res, id, url) {
  const f = qFile.get(id);
  if (!f) throw new HttpError(404, 'File not found');
  const abs = path.join(folderAbs(f.folder_id), f.name);
  let st;
  try { st = fs.statSync(abs); } catch { throw new HttpError(404, 'File is missing on disk — run Rescan'); }
  const inline = url.searchParams.get('inline') === '1' && INLINE_OK.has(f.ext);
  res.writeHead(200, {
    'Content-Type': inline ? f.mime : 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox', // uploaded content can never run scripts in this origin
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  pipeline(fs.createReadStream(abs), res).catch(() => res.destroy());
}

function reveal(req, res, body) {
  const ip = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) throw new HttpError(403, 'Only available on the PC running the library');
  if (process.platform !== 'win32') throw new HttpError(501, 'Open-in-Explorer is Windows only');
  let args;
  if (body.fileId) {
    const f = qFile.get(Number(body.fileId));
    if (!f) throw new HttpError(404, 'File not found');
    args = ['/select,' + path.join(folderAbs(f.folder_id), f.name)];
  } else {
    args = [folderAbs(Number(body.folderId) || 1)];
  }
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
  json(res, 200, { ok: true });
}

// ---------- routing ----------
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  let r;
  if (p === '/api/info' && m === 'GET') return json(res, 200, { libraryPath: LIB, lan: LAN, maxUploadMb: MAX_BYTES / 1048576, canReveal: process.platform === 'win32' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) });
  if (p === '/api/folders' && m === 'GET') return listFolders(res);
  if (p === '/api/folders' && m === 'POST') return createFolder(res, await readJson(req));
  if ((r = p.match(/^\/api\/folders\/(\d+)$/))) {
    if (m === 'PATCH') return patchFolder(res, Number(r[1]), await readJson(req));
    if (m === 'DELETE') return deleteFolder(res, Number(r[1]));
  }
  if (p === '/api/files' && m === 'GET') return listFiles(res, url);
  if (p === '/api/files' && m === 'PUT') return upload(req, res, url);
  if ((r = p.match(/^\/api\/files\/(\d+)$/))) {
    if (m === 'PATCH') return patchFile(res, Number(r[1]), await readJson(req));
    if (m === 'DELETE') return deleteFile(res, Number(r[1]));
  }
  if ((r = p.match(/^\/api\/files\/(\d+)\/download$/)) && (m === 'GET' || m === 'HEAD')) return download(req, res, Number(r[1]), url);
  if (p === '/api/rescan' && m === 'POST') return json(res, 200, rescan());
  if (p === '/api/reveal' && m === 'POST') return reveal(req, res, await readJson(req));
  throw new HttpError(404, 'Unknown endpoint');
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'Not found');
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(abs).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    guard(req);
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else throw new HttpError(405, 'Method not allowed');
  } catch (e) {
    const err = fsError(e);
    if (!(err instanceof HttpError)) {
      if (/UNIQUE constraint/.test(err.message)) err.status = 409, err.message = 'An item with that name already exists here';
      else console.error(err);
    }
    if (res.headersSent) return res.destroy();
    json(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
  }
}).listen(PORT, HOST, () => {
  const s = rescan();
  console.log(`Document Library running at http://localhost:${PORT}${LAN ? '  (LAN access ON)' : ''}`);
  console.log(`Library folder: ${LIB}`);
  if (s.addedFiles || s.removedFiles || s.addedFolders || s.removedFolders) console.log('Startup rescan:', s);
});
