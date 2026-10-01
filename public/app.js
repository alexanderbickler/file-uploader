'use strict';
const $ = (s, r = document) => r.querySelector(s);

// ---------- tiny DOM helper (text is always set via textContent, never innerHTML) ----------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

// ---------- state ----------
const state = { folders: [], byId: new Map(), current: 1, files: [], sort: 'uploaded_at', dir: 'desc', q: '', info: {} };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

// ---------- formatting ----------
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const TYPES = {
  pdf: ['PDF document', 'pdf'], doc: ['Word document', 'word'], docx: ['Word document', 'word'],
  xls: ['Excel workbook', 'excel'], xlsx: ['Excel workbook', 'excel'], csv: ['CSV data', 'excel'],
  ppt: ['PowerPoint deck', 'ppt'], pptx: ['PowerPoint deck', 'ppt'],
  png: ['Image', 'image'], jpg: ['Image', 'image'], jpeg: ['Image', 'image'], gif: ['Image', 'image'], webp: ['Image', 'image'], svg: ['Image', 'image'],
  txt: ['Text file', ''], md: ['Markdown', ''], json: ['JSON data', ''], zip: ['Zip archive', ''],
};
const VIEWABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt']);

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 3000);
}
const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- modal ----------
function modal({ title, build, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg'), body = $('#dlg-body'), okBtn = $('#dlg-ok');
    $('#dlg-title').textContent = title;
    body.replaceChildren();
    const get = build(body);
    okBtn.textContent = ok;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    const form = $('#dlg-form');
    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('cancel', onClose);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(get()); };
    const onClose = () => finish(null); // Esc, Cancel button, or any other dismissal
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('cancel', onClose);
    dlg.showModal();
    body.querySelector('input, select')?.focus();
    body.querySelector('input')?.select();
  });
}
$('#dlg-cancel').addEventListener('click', () => $('#dlg').close('cancel'));

const askText = (title, label, value = '', ok = 'Save') => modal({
  title, ok,
  build(body) {
    const input = h('input', { type: 'text', id: 'dlg-text', required: true, maxlength: 200, value, autocomplete: 'off' });
    body.append(h('label', { for: 'dlg-text' }, label), input);
    return () => input.value.trim();
  },
});
const askConfirm = (title, message, ok = 'Delete') => modal({
  title, ok, danger: true,
  build(body) { body.append(h('p', {}, message)); return () => true; },
});
function askFolder(title, message, excludeId) {
  return modal({
    title, ok: 'Move here',
    build(body) {
      const sel = h('select', { id: 'dlg-folder' });
      const walk = (parent, depth) => {
        for (const f of childrenOf(parent)) {
          if (f.id === excludeId) continue; // can't move a folder into itself / its children
          sel.append(h('option', { value: f.id }, '  '.repeat(depth) + f.name));
          walk(f.id, depth + 1);
        }
      };
      sel.append(h('option', { value: 1 }, 'All documents (top level)'));
      walk(1, 1);
      body.append(h('p', {}, message), h('label', { for: 'dlg-folder' }, 'Destination folder'), sel);
      return () => Number(sel.value);
    },
  });
}

// ---------- folders ----------
const childrenOf = (id) => state.folders.filter((f) => f.parentId === id);
const folderName = (id) => (id === 1 ? 'All documents' : state.byId.get(id)?.name ?? '?');
function chain(id) {
  const out = [];
  for (let f = state.byId.get(id); f && f.parentId !== null; f = state.byId.get(f.parentId)) out.unshift(f); // root excluded
  return out;
}

async function loadFolders() {
  state.folders = await api('/folders');
  state.byId = new Map(state.folders.map((f) => [f.id, f]));
  if (!state.byId.has(state.current)) state.current = 1;
}

function renderTree() {
  const nav = $('#tree');
  nav.replaceChildren();
  const add = (f, depth) => {
    const a = h('a', { href: '#/f/' + f.id, style: `--depth:${depth}`, 'aria-current': !state.q && f.id === state.current ? 'page' : null },
      h('span', { class: 'name' }, f.id === 1 ? 'All documents' : f.name),
      h('span', { class: 'count' }, f.fileCount));
    nav.append(a);
    for (const c of childrenOf(f.id)) add(c, depth + 1);
  };
  add(state.byId.get(1), 0);
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.replaceChildren();
  if (state.q) {
    c.append(h('span', { class: 'here' }, `Search results for “${state.q}”`), ' ', h('a', { href: '#/f/' + state.current, onclick: guarded(async (e) => { e.preventDefault(); $('#search').value = ''; state.q = ''; await refresh(); }) }, 'Clear'));
    return;
  }
  const parts = chain(state.current);
  c.append(parts.length ? h('a', { href: '#/f/1' }, 'All documents') : h('span', { class: 'here' }, 'All documents'));
  parts.forEach((f, i) => {
    c.append(h('span', { class: 'sep' }, '/'));
    c.append(i === parts.length - 1 ? h('span', { class: 'here' }, f.name) : h('a', { href: '#/f/' + f.id }, f.name));
  });
}

// ---------- files ----------
async function loadFiles() {
  const p = new URLSearchParams({ sort: state.sort, dir: state.dir });
  if (state.q) p.set('q', state.q); else p.set('folderId', state.current);
  state.files = await api('/files?' + p);
}

function renderFiles() {
  const rows = $('#rows');
  rows.replaceChildren();
  for (const th of document.querySelectorAll('th[data-sort]'))
    th.setAttribute('aria-sort', th.dataset.sort === state.sort ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  const empty = $('#empty');
  empty.hidden = state.files.length > 0;
  $('#docs thead').hidden = state.files.length === 0;
  empty.textContent = state.q ? 'No documents match your search.' : 'No documents here yet. Use Upload or drop files onto this page.';

  for (const f of state.files) {
    const [label, cls] = TYPES[f.ext] || [f.ext ? f.ext.toUpperCase() + ' file' : 'File', ''];
    const link = h('a', { class: 'fname', href: `/api/files/${f.id}/download` + (VIEWABLE.has(f.ext) ? '?inline=1' : ''), target: VIEWABLE.has(f.ext) ? '_blank' : null, rel: 'noopener' }, f.name);
    rows.append(h('tr', {},
      h('td', { class: 'c-name', 'data-label': 'Document name' }, link, state.q ? h('span', { class: 'where' }, 'in ' + (f.path || 'All documents')) : null),
      h('td', { class: 'c-meta date', 'data-label': 'Uploaded' }, fmtDate(f.uploadedAt)),
      h('td', { class: 'c-meta num', 'data-label': 'Size' }, fmtSize(f.size)),
      h('td', { class: 'c-type', 'data-label': 'File type' }, h('span', { class: 'tag ' + cls }, f.ext ? f.ext.toUpperCase() : '—'), h('span', { class: 'type-label' }, label)),
      h('td', { class: 'c-actions' }, h('div', { class: 'actions' },
        h('a', { class: 'btn btn-sm', href: `/api/files/${f.id}/download`, download: f.name }, 'Download'),
        h('button', { class: 'btn btn-sm', onclick: guarded(() => renameFile(f)) }, 'Rename'),
        h('button', { class: 'btn btn-sm', onclick: guarded(() => moveFile(f)) }, 'Move'),
        state.info.canReveal ? h('button', { class: 'btn btn-sm', onclick: guarded(() => api('/reveal', { method: 'POST', body: { fileId: f.id } })) }, 'Show') : null,
        h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: guarded(() => deleteFile(f)) }, 'Delete'),
      ))));
  }
  const total = state.files.reduce((s, f) => s + f.size, 0);
  $('#summary').textContent = state.files.length ? `${state.files.length} document${state.files.length === 1 ? '' : 's'} · ${fmtSize(total)}` : '';
}

function renderToolbar() {
  const isRoot = state.current === 1;
  $('#folder-actions').hidden = isRoot || !!state.q;
  for (const id of ['rename-folder-btn', 'move-folder-btn', 'delete-folder-btn']) $('#' + id).hidden = isRoot || !!state.q;
  $('#new-folder-btn').hidden = !!state.q;
  $('#reveal-btn').hidden = !state.info.canReveal || !!state.q;
  document.title = (state.q ? 'Search' : folderName(state.current)) + ' · Document Library';
}

function render() { renderTree(); renderCrumbs(); renderToolbar(); renderFiles(); }

async function refresh({ folders = true } = {}) {
  if (folders) await loadFolders();
  await loadFiles();
  render();
}

// ---------- actions ----------
const renameFile = async (f) => {
  const name = await askText('Rename document', 'New name (include the extension)', f.name);
  if (name && name !== f.name) { await api('/files/' + f.id, { method: 'PATCH', body: { name } }); await refresh(); toast('Renamed'); }
};
const moveFile = async (f) => {
  const dest = await askFolder('Move document', `Move “${f.name}” to another folder. The file is moved on disk too.`);
  if (dest != null && dest !== f.folderId) { await api('/files/' + f.id, { method: 'PATCH', body: { folderId: dest } }); await refresh(); toast('Moved to ' + folderName(dest)); }
};
const deleteFile = async (f) => {
  if (await askConfirm('Delete document?', `“${f.name}” will be permanently deleted from disk. This cannot be undone.`)) {
    await api('/files/' + f.id, { method: 'DELETE' }); await refresh(); toast('Deleted');
  }
};

$('#new-folder-btn').addEventListener('click', guarded(async () => {
  const name = await askText('New folder', `Folder name (inside “${folderName(state.current)}”)`, '', 'Create');
  if (name) { const f = await api('/folders', { method: 'POST', body: { parentId: state.current, name } }); await loadFolders(); location.hash = '#/f/' + f.id; }
}));
$('#rename-folder-btn').addEventListener('click', guarded(async () => {
  const name = await askText('Rename folder', 'New folder name', folderName(state.current));
  if (name && name !== folderName(state.current)) { await api('/folders/' + state.current, { method: 'PATCH', body: { name } }); await refresh(); toast('Folder renamed on disk'); }
}));
$('#move-folder-btn').addEventListener('click', guarded(async () => {
  const dest = await askFolder('Move folder', `Move “${folderName(state.current)}” and everything in it.`, state.current);
  if (dest != null) { await api('/folders/' + state.current, { method: 'PATCH', body: { parentId: dest } }); await refresh(); toast('Folder moved on disk'); }
}));
$('#delete-folder-btn').addEventListener('click', guarded(async () => {
  const f = state.byId.get(state.current);
  if (await askConfirm('Delete folder?', `The empty folder “${f.name}” will be removed from disk.`)) {
    await api('/folders/' + f.id, { method: 'DELETE' }); state.current = f.parentId; location.hash = '#/f/' + f.parentId; await refresh(); toast('Folder deleted');
  }
}));
$('#reveal-btn').addEventListener('click', guarded(() => api('/reveal', { method: 'POST', body: { folderId: state.current } })));
$('#rescan-btn').addEventListener('click', guarded(async () => {
  const s = await api('/rescan', { method: 'POST' });
  await refresh();
  const total = s.addedFiles + s.addedFolders + s.removedFiles + s.removedFolders;
  toast(total ? `Rescan: +${s.addedFiles} files, +${s.addedFolders} folders, −${s.removedFiles} files, −${s.removedFolders} folders` : 'Rescan: everything is in sync');
}));

// sorting
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.querySelector('button').addEventListener('click', guarded(async () => {
    const col = th.dataset.sort;
    if (state.sort === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = col; state.dir = col === 'name' || col === 'ext' ? 'asc' : 'desc'; }
    await loadFiles(); renderFiles();
  }));
}

// search (debounced, searches every folder)
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(guarded(async () => { state.q = e.target.value.trim(); await loadFiles(); render(); }), 250);
});
$('#search-form').addEventListener('submit', (e) => e.preventDefault());

// ---------- uploads ----------
const queue = [];
let uploading = false;
function enqueue(files) {
  const target = state.current;
  for (const file of files) {
    if (state.info.maxUploadMb && file.size > state.info.maxUploadMb * 1048576) { toast(`${file.name} is over the ${state.info.maxUploadMb} MB limit`, true); continue; }
    const bar = h('progress', { max: 100, value: 0 });
    const st = h('span', { class: 'st' }, 'Waiting…');
    const row = h('div', { class: 'up-item' }, h('span', {}, file.name), st, bar);
    $('#uploads').append(row);
    queue.push({ file, target, row, st, bar });
  }
  $('#uploads').hidden = !queue.length && !$('#uploads').children.length;
  pump();
}
async function pump() {
  if (uploading) return;
  uploading = true;
  let any = false;
  while (queue.length) {
    const job = queue.shift();
    try {
      const f = await sendFile(job);
      job.row.classList.add('ok');
      job.st.textContent = f.renamed ? `Saved as “${f.name}”` : 'Done';
      any = true;
    } catch (e) {
      job.row.classList.add('err');
      job.st.textContent = e.message;
    }
    job.bar.remove();
  }
  uploading = false;
  if (any) await refresh();
  setTimeout(() => { if (!uploading) { $('#uploads').replaceChildren(); $('#uploads').hidden = true; } }, 6000);
}
function sendFile({ file, target, st, bar }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files?folderId=${target}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.value = (e.loaded / e.total) * 100; st.textContent = Math.round((e.loaded / e.total) * 100) + '%'; } };
    xhr.onload = () => {
      let data = null; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      xhr.status < 300 ? resolve(data) : reject(new Error(data?.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    st.textContent = '0%';
    xhr.send(file);
  });
}
$('#upload-btn').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => { enqueue([...e.target.files]); e.target.value = ''; });

// drag & drop
const main = $('#main');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; main.classList.add('dragging'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; main.classList.remove('dragging'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; main.classList.remove('dragging');
  enqueue([...e.dataTransfer.files].filter((f) => f.size > 0 || f.type)); // skips dropped folders (size 0, no type)
});

// ---------- navigation + mobile drawer ----------
const sidebar = $('#sidebar'), backdrop = $('#backdrop'), menuBtn = $('#menu-btn');
function drawer(open) {
  sidebar.classList.toggle('open', open); backdrop.classList.toggle('show', open); menuBtn.setAttribute('aria-expanded', open);
}
menuBtn.addEventListener('click', () => drawer(!sidebar.classList.contains('open')));
backdrop.addEventListener('click', () => drawer(false));

async function onHash() {
  const m = location.hash.match(/^#\/f\/(\d+)$/);
  state.current = m ? Number(m[1]) : 1;
  if (!state.byId.has(state.current)) await loadFolders();
  if (!state.byId.has(state.current)) state.current = 1;
  state.q = ''; $('#search').value = '';
  drawer(false);
  await refresh({ folders: true });
}
addEventListener('hashchange', guarded(onHash));

(async () => {
  try {
    state.info = await api('/info');
    $('#lib-path').textContent = state.info.libraryPath;
    await onHash();
  } catch (e) { toast(e.message, true); }
})();
