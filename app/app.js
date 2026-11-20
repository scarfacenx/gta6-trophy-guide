// GTA VI Trophy Guide: offline checklist, roadmap, filters, spoiler mode and saved progress.
const STORAGE_KEY = 'gta6-trophy-progress-v1';
const GRADES = ['platinum', 'gold', 'silver', 'bronze'];
const KIND_LABELS = { story: 'Story', side: 'Side', collectible: 'Collectible', challenge: 'Challenge', online: 'Online', misc: 'Misc' };
const TABS = ['checklist', 'roadmap'];
const HIDDEN_NAME = 'Hidden story trophy';
const HIDDEN_DESC = 'Turn spoiler mode off to read this.';
const HIDDEN_CHIP = 'Hidden';

const byId = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function icon(symbol, className) {
  const svg = document.querySelector('svg.icon').cloneNode(true);
  svg.setAttribute('class', className ? 'icon ' + className : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.querySelector('use').setAttribute('href', '#' + symbol);
  return svg;
}

function tplIcon(templateId, className) {
  const source = byId(templateId);
  const node = source.content.firstElementChild.cloneNode(true);
  if (className) node.classList.add(...className.split(' '));
  return node;
}

function fold(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'").toLowerCase();
}

const defaultFilters = () => ({ grade: 'all', kind: 'all', query: '', hideCompleted: false, missablesOnly: false });
const state = { earned: new Set(), spoiler: false, filters: defaultFilters(), tab: 'checklist' };

let trophies = [];
let roadmap = null;
let byTrophyId = new Map();
let byTrophyName = new Map();
let validIds = new Set();
const rowRefs = new Map();
const detailDialog = byId('detail-dialog');
const resetDialog = byId('reset-dialog');
let detailOrder = [];
let detailIndex = 0;
const detailRevealed = new Set();
let searchTimer = 0;
let toastTimer = 0;

function sanitizeFilters(raw) {
  const filters = defaultFilters();
  if (!raw || typeof raw !== 'object') return filters;
  if (raw.grade === 'all' || GRADES.includes(raw.grade)) filters.grade = raw.grade;
  if (raw.kind === 'all' || Object.hasOwn(KIND_LABELS, raw.kind)) filters.kind = raw.kind;
  if (typeof raw.query === 'string') filters.query = raw.query.slice(0, 200);
  filters.hideCompleted = raw.hideCompleted === true;
  filters.missablesOnly = raw.missablesOnly === true;
  return filters;
}

function sanitizeEarned(raw) {
  const ids = new Set();
  if (!Array.isArray(raw)) return ids;
  for (const value of raw) {
    const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (Number.isInteger(id) && validIds.has(id)) ids.add(id);
  }
  return ids;
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || typeof raw !== 'object') return;
    state.earned = sanitizeEarned(raw.earned);
    state.spoiler = raw.spoiler === true;
    state.filters = sanitizeFilters(raw.filters);
    if (TABS.includes(raw.tab)) state.tab = raw.tab;
  } catch (error) {
    state.earned = new Set();
    state.spoiler = false;
    state.filters = defaultFilters();
    state.tab = 'checklist';
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      earned: [...state.earned].sort((a, b) => a - b),
      spoiler: state.spoiler,
      filters: state.filters,
      tab: state.tab,
    }));
  } catch (error) {
    // Storage can be unavailable in private modes; the guide keeps working for this session.
  }
}

const isEarned = (trophy) => state.earned.has(trophy.id);
const isHidden = (trophy) => state.spoiler && trophy.kind === 'story' && !isEarned(trophy);
const kindLabel = (kind) => KIND_LABELS[kind] || kind;
const padId = (id) => '#' + String(id).padStart(2, '0');

function gradeBadge(grade) {
  return el('span', 'badge badge--' + grade, grade);
}

function missableBadge() {
  const badge = el('span', 'badge badge--missable');
  badge.append(tplIcon('tpl-icon-warning'), document.createTextNode('Missable'));
  return badge;
}

function earnedBadge() {
  const badge = el('span', 'badge badge--earned');
  badge.append(tplIcon('tpl-icon-check'), document.createTextNode('Earned'));
  return badge;
}

function lockedBadge() {
  const badge = el('span', 'badge badge--locked');
  badge.append(tplIcon('tpl-icon-lock'), document.createTextNode('Hidden'));
  return badge;
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

function activeFilterParts() {
  const filters = state.filters;
  const parts = [];
  if (filters.grade !== 'all') parts.push('grade "' + filters.grade + '"');
  if (filters.kind !== 'all') parts.push('kind "' + kindLabel(filters.kind) + '"');
  if (filters.query.trim()) parts.push('search "' + filters.query.trim() + '"');
  if (filters.hideCompleted) parts.push('hide completed');
  if (filters.missablesOnly) parts.push('missables only');
  return parts;
}

function filteredTrophies() {
  const filters = state.filters;
  const tokens = fold(filters.query).split(/\s+/).filter(Boolean);
  return trophies.filter((trophy) => {
    if (filters.grade !== 'all' && trophy.grade !== filters.grade) return false;
    if (filters.kind !== 'all' && trophy.kind !== filters.kind) return false;
    if (filters.hideCompleted && isEarned(trophy)) return false;
    if (filters.missablesOnly && !trophy.missable) return false;
    if (tokens.length) {
      const haystack = fold(trophy.name + ' ' + trophy.description + ' ' + trophy.guide);
      if (!tokens.every((token) => haystack.includes(token))) return false;
    }
    return true;
  });
}

function renderHeader() {
  const total = trophies.length || 55;
  const earned = state.earned.size;
  const percent = total ? Math.round((earned / total) * 100) : 0;
  const done = total > 0 && earned === total;
  byId('earned-count').textContent = String(earned);
  byId('progress-total').textContent = '/ ' + total;
  byId('percent').textContent = percent + '%';
  const bar = byId('progressbar');
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(earned));
  bar.setAttribute('aria-valuetext', earned + ' of ' + total + ' trophies earned');
  byId('bar-fill').style.width = percent + '%';
  byId('platinum-status').classList.toggle('is-earned', done);
  byId('platinum-text').textContent = done ? 'Platinum earned' : 'Platinum locked';
}

function renderGradeStats() {
  const wrap = byId('grade-stats');
  wrap.replaceChildren();
  for (const grade of GRADES) {
    const pool = trophies.filter((trophy) => trophy.grade === grade);
    const done = pool.filter(isEarned).length;
    const button = el('button', 'grade-stat grade-stat--' + grade);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.filters.grade === grade));
    button.setAttribute('aria-label', 'Filter ' + grade + ' trophies (' + done + ' of ' + pool.length + ' earned)');
    button.append(el('span', 'dot'), document.createTextNode(grade), el('span', 'count', done + '/' + pool.length));
    button.addEventListener('click', () => {
      state.filters.grade = state.filters.grade === grade ? 'all' : grade;
      saveState();
      syncControls();
      renderGradeStats();
      renderList();
    });
    wrap.append(button);
  }
}

function syncControls() {
  byId('grade-filter').value = state.filters.grade;
  byId('kind-filter').value = state.filters.kind;
  byId('hide-completed').checked = state.filters.hideCompleted;
  byId('missables-only').checked = state.filters.missablesOnly;
  byId('spoiler-toggle').checked = state.spoiler;
  const search = byId('search');
  if (search.value !== state.filters.query) search.value = state.filters.query;
  byId('search-clear').hidden = state.filters.query.length === 0;
  byId('clear-filters').hidden = activeFilterParts().length === 0;
}

function buildRow(trophy) {
  const hidden = isHidden(trophy);
  const item = el('li', 'trophy');
  item.dataset.grade = trophy.grade;
  item.dataset.earned = String(isEarned(trophy));
  if (hidden) item.dataset.locked = 'true';
  else delete item.dataset.locked;

  const wrap = el('label', 'check-wrap');
  const box = el('input', 'earn');
  box.type = 'checkbox';
  box.checked = isEarned(trophy);
  box.setAttribute('aria-label', 'Mark "' + (hidden ? HIDDEN_NAME : trophy.name) + '" as earned');
  box.addEventListener('change', () => setEarned(trophy.id, box.checked));
  const visual = el('span', 'check-box');
  visual.append(tplIcon('tpl-icon-check'));
  wrap.append(box, visual);

  const main = el('button', 'trophy-main');
  main.type = 'button';
  main.setAttribute('aria-haspopup', 'dialog');
  main.setAttribute('aria-label', 'Open guide for ' + (hidden ? HIDDEN_NAME : trophy.name));
  const top = el('span', 'trophy-top');
  top.append(gradeBadge(trophy.grade), el('span', 'trophy-name', hidden ? HIDDEN_NAME : trophy.name));
  if (trophy.missable) top.append(missableBadge());
  if (hidden) top.append(lockedBadge());
  top.append(earnedBadge());
  const desc = el('span', 'trophy-desc', hidden ? HIDDEN_DESC : trophy.description);
  const excerpt = el('span', 'trophy-excerpt', hidden ? '' : trophy.guide);
  if (hidden) excerpt.hidden = true;
  const meta = el('span', 'trophy-meta');
  meta.append(el('span', 'chip chip--id', padId(trophy.id)), el('span', 'chip chip--kind', kindLabel(trophy.kind)));
  main.append(top, desc, excerpt, meta);
  main.addEventListener('click', () => openDetail(trophy.id));

  const chevron = el('span', 'trophy-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.append(icon('i-chevron-right'));

  item.append(wrap, main, chevron);
  return { item, box };
}

function renderList() {
  const list = byId('trophy-list');
  const visible = filteredTrophies();
  rowRefs.clear();
  list.replaceChildren();
  for (const trophy of visible) {
    const row = buildRow(trophy);
    rowRefs.set(trophy.id, row);
    list.append(row.item);
  }
  const active = activeFilterParts();
  byId('visible-count').textContent = 'Showing ' + visible.length + ' of ' + trophies.length + ' trophies (' + visible.filter(isEarned).length + ' earned in this view)';
  byId('clear-filters').hidden = active.length === 0;
  const empty = byId('empty-state');
  empty.hidden = visible.length !== 0;
  if (!visible.length) {
    byId('empty-text').textContent = active.length
      ? 'No trophies match ' + active.join(', ') + '. Try a shorter search or clear the filters.'
      : 'No trophies match these filters.';
  }
}

function setEarned(id, earned) {
  const trophy = byTrophyId.get(id);
  if (!trophy) return;
  if (earned) state.earned.add(id);
  else state.earned.delete(id);
  saveState();
  renderHeader();
  renderGradeStats();
  if (state.filters.hideCompleted || (state.spoiler && trophy.kind === 'story')) {
    renderList();
  } else {
    const row = rowRefs.get(id);
    if (row) {
      row.item.dataset.earned = String(earned);
      row.box.checked = earned;
      if (isHidden(trophy)) row.item.dataset.locked = 'true';
      else delete row.item.dataset.locked;
    }
    byId('visible-count').textContent = 'Showing ' + rowRefs.size + ' of ' + trophies.length + ' trophies (' + [...rowRefs.keys()].filter((key) => state.earned.has(key)).length + ' earned in this view)';
  }
  renderRoadmap();
  if (detailDialog.open && detailOrder[detailIndex] === id) fillDetail();
  if (earned && state.earned.size === trophies.length) showToast('Platinum earned. Leonida legend!');
}

function setTab(tab) {
  if (!TABS.includes(tab)) tab = 'checklist';
  state.tab = tab;
  saveState();
  for (const name of TABS) {
    const button = byId('tab-' + name);
    const selected = name === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId('panel-' + name).hidden = !selected;
  }
}

function setSpoiler(on) {
  state.spoiler = on;
  detailRevealed.clear();
  saveState();
  syncControls();
  renderList();
  renderRoadmap();
  if (detailDialog.open) fillDetail();
}

function openDetail(id) {
  const visible = filteredTrophies();
  const pool = visible.some((trophy) => trophy.id === id) ? visible : trophies;
  detailOrder = pool.map((trophy) => trophy.id);
  detailIndex = Math.max(0, detailOrder.indexOf(id));
  fillDetail();
  if (!detailDialog.open) detailDialog.showModal();
}

function fillDetail() {
  const trophy = byTrophyId.get(detailOrder[detailIndex]);
  if (!trophy) return;
  const hidden = isHidden(trophy) && !detailRevealed.has(trophy.id);
  byId('detail-title').textContent = hidden ? HIDDEN_NAME : trophy.name;
  byId('detail-desc').textContent = hidden ? HIDDEN_DESC : trophy.description;

  const badges = byId('detail-badges');
  badges.replaceChildren(gradeBadge(trophy.grade), el('span', 'chip chip--kind', kindLabel(trophy.kind)), el('span', 'chip chip--id', padId(trophy.id)));
  if (trophy.missable) badges.append(missableBadge());
  if (isEarned(trophy)) {
    const earned = el('span', 'chip');
    earned.append(tplIcon('tpl-icon-check'), document.createTextNode('Earned'));
    badges.append(earned);
  }

  byId('detail-locked').hidden = !hidden;
  byId('detail-content').hidden = hidden;
  byId('detail-guide').textContent = hidden ? '' : trophy.guide;
  const tips = byId('detail-tips');
  tips.replaceChildren();
  if (!hidden) for (const tip of trophy.tips || []) tips.append(el('li', '', tip));
  const sources = byId('detail-sources');
  sources.replaceChildren();
  if (!hidden) for (const source of trophy.sources || []) sources.append(el('li', '', source));
  byId('detail-earned').checked = isEarned(trophy);
  byId('detail-position').textContent = (detailIndex + 1) + ' / ' + detailOrder.length;
  byId('detail-prev').disabled = detailIndex <= 0;
  byId('detail-next').disabled = detailIndex >= detailOrder.length - 1;
}

function stepDetail(offset) {
  const next = detailIndex + offset;
  if (next < 0 || next >= detailOrder.length) return;
  detailIndex = next;
  fillDetail();
}

function clearFilters() {
  clearTimeout(searchTimer);
  state.filters = defaultFilters();
  saveState();
  syncControls();
  renderGradeStats();
  renderList();
  showToast('Filters cleared');
}

function exportProgress() {
  const payload = {
    app: 'gta6-trophy-guide',
    version: 1,
    exportedAt: new Date().toISOString(),
    total: trophies.length,
    earned: [...state.earned].sort((a, b) => a - b),
    spoiler: state.spoiler,
    filters: state.filters,
    tab: state.tab,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gta6-trophy-progress.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Progress exported');
}

function parseImport(text) {
  const raw = JSON.parse(text);
  const payload = Array.isArray(raw) ? { earned: raw } : raw;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.earned)) {
    throw new Error('expected an object with an "earned" array of trophy ids');
  }
  const earned = new Set();
  for (const value of payload.earned) {
    const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isInteger(id) || !validIds.has(id)) throw new Error('unknown trophy id ' + JSON.stringify(value));
    earned.add(id);
  }
  return {
    earned,
    spoiler: payload.spoiler === true,
    filters: sanitizeFilters(payload.filters),
    tab: TABS.includes(payload.tab) ? payload.tab : state.tab,
  };
}

async function importProgress(file) {
  try {
    const parsed = parseImport(await file.text());
    state.earned = parsed.earned;
    state.spoiler = parsed.spoiler;
    state.filters = parsed.filters;
    state.tab = parsed.tab;
    saveState();
    syncControls();
    renderHeader();
    renderGradeStats();
    renderList();
    renderRoadmap();
    setTab(parsed.tab);
    if (detailDialog.open) fillDetail();
    showToast('Imported ' + parsed.earned.size + ' earned trophies');
  } catch (error) {
    showToast('Import failed: ' + (error && error.message ? error.message : 'invalid file'));
  }
}

function trophyChip(trophy) {
  const hidden = isHidden(trophy);
  const chip = el('button', 'tchip');
  chip.type = 'button';
  chip.dataset.grade = trophy.grade;
  chip.dataset.earned = String(isEarned(trophy));
  chip.dataset.missable = String(trophy.missable === true);
  chip.dataset.hidden = String(hidden);
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-label', 'Open guide for ' + (hidden ? HIDDEN_NAME : trophy.name) + (isEarned(trophy) ? ' (earned)' : ''));
  chip.append(
    el('span', 'dot'),
    tplIcon('tpl-icon-check', 'check'),
    tplIcon('tpl-icon-lock', 'chip-lock'),
    el('span', '', hidden ? HIDDEN_CHIP : trophy.name)
  );
  chip.addEventListener('click', () => openDetail(trophy.id));
  return chip;
}

function summaryPill(value, label) {
  const pill = el('span', 'summary-pill');
  pill.append(el('strong', '', value), document.createTextNode(' ' + label));
  return pill;
}

function renderRoadmap() {
  const root = byId('roadmap-root');
  root.replaceChildren();
  if (!roadmap) return;

  const head = el('div', 'roadmap-head');
  const intro = el('div');
  intro.append(
    el('h2', 'roadmap-title', 'The road to the platinum'),
    el('p', 'roadmap-sub', 'Six stages from the first mission to "' + (roadmap.platinum || 'the platinum') + '". Work top to bottom, keep the two missables safe, then sweep the map. Ticks here and in the checklist share one save.')
  );
  const summary = el('div', 'roadmap-summary');
  summary.append(
    summaryPill(trophies.length, 'trophies'),
    summaryPill(state.earned.size, 'earned'),
    summaryPill((roadmap.missables || []).length, 'missables'),
    summaryPill((roadmap.stages || []).length, 'stages')
  );
  head.append(intro, summary);
  root.append(head);

  const stages = el('ol', 'stages');
  (roadmap.stages || []).forEach((stage, index) => {
    const names = stage.trophies || [];
    const found = names.map((name) => byTrophyName.get(name)).filter(Boolean);
    const done = found.filter(isEarned).length;
    const item = el('li', 'stage');
    if (found.length && done === found.length) item.classList.add('is-complete');

    const headRow = el('div', 'stage-head');
    headRow.append(el('span', 'stage-num', 'Stage ' + (index + 1)));
    const titleWrap = el('div');
    titleWrap.append(el('h3', 'stage-title', stage.title));
    headRow.append(titleWrap);
    const progress = el('span', 'stage-progress');
    progress.append(document.createTextNode(done + ' / ' + found.length));
    const mini = el('span', 'mini-bar');
    const fill = el('span');
    fill.style.width = found.length ? Math.round((done / found.length) * 100) + '%' : '0%';
    mini.append(fill);
    progress.append(mini);
    headRow.append(progress);
    item.append(headRow, el('p', 'stage-why', stage.why));

    const chips = el('div', 'chips');
    for (const name of names) {
      const trophy = byTrophyName.get(name);
      chips.append(trophy ? trophyChip(trophy) : el('span', 'chip', name));
    }
    item.append(chips);
    stages.append(item);
  });
  root.append(stages);

  const missCard = el('section', 'info-card info-card--warn');
  const missTitle = el('h3');
  missTitle.append(tplIcon('tpl-icon-warning'), document.createTextNode('Missable trophies'));
  missCard.append(missTitle, el('p', '', 'These can be lost for good if their story window closes. Keep a manual save before each one and do not overwrite it until the trophy has popped.'));
  const missChips = el('div', 'chips');
  for (const name of roadmap.missables || []) {
    const trophy = byTrophyName.get(name);
    if (trophy) missChips.append(trophyChip(trophy));
  }
  missCard.append(missChips);
  root.append(missCard);

  const notesCard = el('section', 'info-card');
  const notesTitle = el('h3');
  notesTitle.append(icon('i-info'), document.createTextNode('Route notes'));
  const notes = el('ul', 'notes-list');
  for (const note of roadmap.notes || []) notes.append(el('li', '', note));
  notesCard.append(notesTitle, notes);
  root.append(notesCard);

  root.append(el('p', 'roadmap-foot', 'Every chip opens the full guide. Progress lives in this browser; export a JSON backup before clearing site data.'));
}

function resetProgress() {
  state.earned = new Set();
  saveState();
  resetDialog.close();
  renderHeader();
  renderGradeStats();
  renderList();
  renderRoadmap();
  if (detailDialog.open) fillDetail();
  showToast('Progress reset');
}

function wireEvents() {
  byId('tab-checklist').addEventListener('click', () => setTab('checklist'));
  byId('tab-roadmap').addEventListener('click', () => setTab('roadmap'));
  byId('tabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = state.tab === 'checklist' ? 'roadmap' : 'checklist';
    setTab(next);
    byId('tab-' + next).focus();
  });

  byId('search').addEventListener('input', (event) => {
    const value = event.target.value;
    byId('search-clear').hidden = value.length === 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.query = value;
      saveState();
      syncControls();
      renderList();
    }, 180);
  });
  byId('search-clear').addEventListener('click', () => {
    clearTimeout(searchTimer);
    state.filters.query = '';
    saveState();
    syncControls();
    renderList();
    byId('search').focus();
  });
  byId('grade-filter').addEventListener('change', (event) => {
    state.filters.grade = event.target.value;
    saveState();
    syncControls();
    renderGradeStats();
    renderList();
  });
  byId('kind-filter').addEventListener('change', (event) => {
    state.filters.kind = event.target.value;
    saveState();
    syncControls();
    renderList();
  });
  byId('hide-completed').addEventListener('change', (event) => {
    state.filters.hideCompleted = event.target.checked;
    saveState();
    syncControls();
    renderList();
  });
  byId('missables-only').addEventListener('change', (event) => {
    state.filters.missablesOnly = event.target.checked;
    saveState();
    syncControls();
    renderList();
  });
  byId('spoiler-toggle').addEventListener('change', (event) => setSpoiler(event.target.checked));
  byId('clear-filters').addEventListener('click', clearFilters);
  byId('empty-clear').addEventListener('click', clearFilters);

  byId('export-btn').addEventListener('click', exportProgress);
  byId('import-btn').addEventListener('click', () => byId('import-file').click());
  byId('import-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importProgress(file);
  });

  byId('reset-btn').addEventListener('click', () => resetDialog.showModal());
  byId('reset-cancel').addEventListener('click', () => resetDialog.close());
  byId('reset-confirm').addEventListener('click', resetProgress);
  resetDialog.addEventListener('click', (event) => {
    if (event.target === resetDialog) resetDialog.close();
  });

  byId('detail-close').addEventListener('click', () => detailDialog.close());
  byId('detail-prev').addEventListener('click', () => stepDetail(-1));
  byId('detail-next').addEventListener('click', () => stepDetail(1));
  byId('detail-reveal').addEventListener('click', () => {
    const id = detailOrder[detailIndex];
    if (id === undefined) return;
    detailRevealed.add(id);
    fillDetail();
  });
  byId('detail-earned').addEventListener('change', (event) => {
    const id = detailOrder[detailIndex];
    if (id !== undefined) setEarned(id, event.target.checked);
  });
  detailDialog.addEventListener('click', (event) => {
    if (event.target === detailDialog) detailDialog.close();
  });
  detailDialog.addEventListener('close', () => detailRevealed.clear());

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (detailDialog.open || resetDialog.open) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    event.preventDefault();
    setTab('checklist');
    byId('search').focus();
    byId('search').select();
  });
}

async function boot() {
  try {
    const responses = await Promise.all([fetch('./data/trophies.json'), fetch('./data/roadmap.json')]);
    if (!responses[0].ok) throw new Error('trophies.json returned HTTP ' + responses[0].status);
    if (!responses[1].ok) throw new Error('roadmap.json returned HTTP ' + responses[1].status);
    const trophyDoc = await responses[0].json();
    const roadmapDoc = await responses[1].json();
    if (!trophyDoc || !Array.isArray(trophyDoc.trophies) || trophyDoc.trophies.length === 0) {
      throw new Error('trophies.json has no trophy list');
    }
    trophies = trophyDoc.trophies;
    roadmap = roadmapDoc && typeof roadmapDoc === 'object' ? roadmapDoc : null;
  } catch (error) {
    byId('boot').hidden = true;
    byId('boot-error').hidden = false;
    byId('boot-error-text').textContent = 'Could not load the guide data: ' + (error && error.message ? error.message : 'unknown error') + '.';
    return;
  }

  byTrophyId = new Map(trophies.map((trophy) => [trophy.id, trophy]));
  byTrophyName = new Map(trophies.map((trophy) => [trophy.name, trophy]));
  validIds = new Set(byTrophyId.keys());

  loadState();
  wireEvents();
  syncControls();
  renderHeader();
  renderGradeStats();
  renderList();
  renderRoadmap();
  setTab(state.tab);
  byId('boot').hidden = true;
}

boot();
