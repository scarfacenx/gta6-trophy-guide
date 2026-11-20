// GTA VI trophy guide: offline checklist, roadmap, filters, spoiler mode and saved progress.
// One ES module, no imports. Data comes from ./data/*.json; progress lives in localStorage.

const PROGRESS_KEY = 'gta6-trophy-progress-v1';
const PREFS_KEY = 'gta6-trophy-guide-prefs-v1';
const GRADE_ORDER = ['platinum', 'gold', 'silver', 'bronze'];
const KIND_NAMES = { story: 'Story', side: 'Side', collectible: 'Collectible', challenge: 'Challenge', online: 'Online', misc: 'Misc' };
const VIEW_NAMES = ['checklist', 'roadmap'];
const MASK_NAME = 'Hidden story trophy';
const MASK_DESC = 'Turn spoiler mode off to read this.';
const MASK_CHIP = 'Hidden';
const SEARCH_DEBOUNCE_MS = 180;
const TOAST_LINGER_MS = 2800;
const SVG_NS = 'http://www.w3.org/2000/svg';

const dom = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function sprite(symbol, extraClass) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', extraClass ? 'icon ' + extraClass : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#' + symbol);
  svg.append(use);
  return svg;
}

function fromTemplate(templateId, extraClass) {
  const node = dom[templateId].content.firstElementChild.cloneNode(true);
  if (extraClass) node.classList.add(...extraClass.split(' '));
  return node;
}

function labelledBadge(className, templateId, label) {
  const badge = make('span', className);
  badge.append(fromTemplate(templateId), document.createTextNode(label));
  return badge;
}

function sourceItem(source) {
  const text = String(source);
  const item = make('li');
  const match = text.match(/https?:\/\/[^\s)]+/);
  if (!match) {
    item.textContent = text;
    return item;
  }
  const url = match[0];
  const at = text.indexOf(url);
  const link = make('a', '', url);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  item.append(document.createTextNode(text.slice(0, at)), link, document.createTextNode(text.slice(at + url.length)));
  return item;
}

const gradeBadge = (grade) => make('span', 'badge badge--' + grade, grade);
const missableBadge = () => labelledBadge('badge badge--missable', 'tpl-icon-warning', 'Missable');
const earnedBadge = () => labelledBadge('badge badge--earned', 'tpl-icon-check', 'Earned');
const hiddenBadge = () => labelledBadge('badge badge--locked', 'tpl-icon-lock', MASK_CHIP);

function foldText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

const guide = {
  trophies: [],
  byId: new Map(),
  byName: new Map(),
  knownIds: new Set(),
  platinum: null,
  roadmap: null,
};

function blankFilters() {
  return { grade: 'all', kind: 'all', query: '', hideCompleted: false, missablesOnly: false };
}

const session = {
  earned: new Set(),
  spoiler: false,
  filters: blankFilters(),
  view: 'checklist',
};

const earnedHas = (trophy) => session.earned.has(trophy.id);
const concealed = (trophy) => session.spoiler && trophy.kind === 'story' && !earnedHas(trophy);
const kindName = (kind) => KIND_NAMES[kind] || kind;
const sortedEarned = () => [...session.earned].sort((left, right) => left - right);
const slotLabel = (trophy) => '#' + String(guide.trophies.indexOf(trophy) + 1).padStart(2, '0');

function gateShut() {
  return guide.trophies.some((trophy) => trophy.grade !== 'platinum' && !session.earned.has(trophy.id));
}

function gateHint() {
  const rest = guide.trophies.length - 1;
  return gateShut()
    ? 'Earn the other ' + rest + ' trophies first'
    : 'Earned automatically: all ' + rest + ' other trophies are done';
}

function enforcePlatinumGate() {
  if (!guide.platinum) return;
  if (gateShut()) session.earned.delete(guide.platinum.id);
  else session.earned.add(guide.platinum.id);
}

function coerceId(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

function collectKnownIds(raw) {
  const found = new Set();
  if (!Array.isArray(raw)) return found;
  for (const entry of raw) {
    const id = coerceId(entry);
    if (Number.isInteger(id) && guide.knownIds.has(id)) found.add(id);
  }
  return found;
}

function cleanFilters(raw) {
  const filters = blankFilters();
  if (!raw || typeof raw !== 'object') return filters;
  if (raw.grade === 'all' || GRADE_ORDER.includes(raw.grade)) filters.grade = raw.grade;
  if (raw.kind === 'all' || Object.hasOwn(KIND_NAMES, raw.kind)) filters.kind = raw.kind;
  if (typeof raw.query === 'string') filters.query = raw.query.slice(0, 200);
  filters.hideCompleted = raw.hideCompleted === true;
  filters.missablesOnly = raw.missablesOnly === true;
  return filters;
}

function readSavedState() {
  try {
    const progressRaw = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    const prefsRaw = JSON.parse(localStorage.getItem(PREFS_KEY));
    let earnedRaw = null;
    let legacy = null;
    if (Array.isArray(progressRaw)) {
      earnedRaw = progressRaw;
    } else if (progressRaw && typeof progressRaw === 'object') {
      legacy = progressRaw;
      earnedRaw = progressRaw.earned;
    }
    session.earned = collectKnownIds(earnedRaw);
    enforcePlatinumGate();
    const prefs = legacy || (prefsRaw && typeof prefsRaw === 'object' ? prefsRaw : {});
    session.spoiler = prefs.spoiler === true;
    session.filters = cleanFilters(prefs.filters);
    if (VIEW_NAMES.includes(prefs.tab)) session.view = prefs.tab;
  } catch {
    session.earned = new Set();
    session.spoiler = false;
    session.filters = blankFilters();
    session.view = 'checklist';
  }
}

function persist() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(sortedEarned()));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ spoiler: session.spoiler, filters: session.filters, tab: session.view }));
  } catch {
    // Storage can be unavailable in private modes; the guide keeps working for this session.
  }
}

function activeFilterNotes() {
  const filters = session.filters;
  const notes = [];
  if (filters.grade !== 'all') notes.push('grade "' + filters.grade + '"');
  if (filters.kind !== 'all') notes.push('kind "' + kindName(filters.kind) + '"');
  if (filters.query.trim()) notes.push('search "' + filters.query.trim() + '"');
  if (filters.hideCompleted) notes.push('hide completed');
  if (filters.missablesOnly) notes.push('missables only');
  return notes;
}

function searchTokens() {
  return foldText(session.filters.query).split(/\s+/).filter(Boolean);
}

function matchesFilters(trophy, tokens) {
  const filters = session.filters;
  if (filters.grade !== 'all' && trophy.grade !== filters.grade) return false;
  if (filters.kind !== 'all' && trophy.kind !== filters.kind) return false;
  if (filters.hideCompleted && earnedHas(trophy)) return false;
  if (filters.missablesOnly && trophy.missable !== true) return false;
  if (tokens.length) {
    const source = concealed(trophy)
      ? MASK_NAME + ' ' + MASK_DESC
      : trophy.name + ' ' + trophy.description + ' ' + trophy.guide;
    const haystack = foldText(source);
    if (!tokens.every((token) => haystack.includes(token))) return false;
  }
  return true;
}

function visibleTrophies() {
  const tokens = searchTokens();
  return guide.trophies.filter((trophy) => matchesFilters(trophy, tokens));
}

function paintSummary() {
  const total = guide.trophies.length || 55;
  const earned = session.earned.size;
  const percent = total ? Math.round((earned / total) * 100) : 0;
  const complete = total > 0 && earned === total;
  dom['earned-count'].textContent = String(earned);
  dom['progress-total'].textContent = '/ ' + total;
  dom['percent'].textContent = percent + '%';
  const bar = dom['progressbar'];
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(earned));
  bar.setAttribute('aria-valuetext', earned + ' of ' + total + ' trophies earned');
  dom['bar-fill'].style.width = percent + '%';
  dom['platinum-status'].classList.toggle('is-earned', complete);
  dom['platinum-text'].textContent = complete ? 'Platinum earned' : 'Platinum locked';
}

function paintGradeChips() {
  const wrap = dom['grade-stats'];
  wrap.replaceChildren();
  for (const grade of GRADE_ORDER) {
    const pool = guide.trophies.filter((trophy) => trophy.grade === grade);
    const done = pool.filter(earnedHas).length;
    const chip = make('button', 'grade-stat grade-stat--' + grade);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(session.filters.grade === grade));
    chip.setAttribute('aria-label', 'Filter ' + grade + ' trophies (' + done + ' of ' + pool.length + ' earned)');
    chip.append(make('span', 'dot'), document.createTextNode(grade), make('span', 'count', done + '/' + pool.length));
    chip.addEventListener('click', () => {
      session.filters.grade = session.filters.grade === grade ? 'all' : grade;
      persist();
      syncFilterControls();
      paintGradeChips();
      paintChecklist();
    });
    wrap.append(chip);
  }
}

function syncFilterControls() {
  dom['grade-filter'].value = session.filters.grade;
  dom['kind-filter'].value = session.filters.kind;
  dom['hide-completed'].checked = session.filters.hideCompleted;
  dom['missables-only'].checked = session.filters.missablesOnly;
  dom['spoiler-toggle'].checked = session.spoiler;
  if (dom['search'].value !== session.filters.query) dom['search'].value = session.filters.query;
  dom['search-clear'].hidden = session.filters.query.length === 0;
  dom['clear-filters'].hidden = activeFilterNotes().length === 0;
}

const rowIndex = new Map();

function checklistRow(trophy) {
  const masked = concealed(trophy);
  const shownName = masked ? MASK_NAME : trophy.name;
  const row = make('li', 'trophy');
  row.dataset.grade = trophy.grade;
  row.dataset.earned = String(earnedHas(trophy));
  if (masked) row.dataset.locked = 'true';

  const tickWrap = make('label', 'check-wrap');
  const tick = make('input', 'earn');
  tick.type = 'checkbox';
  tick.checked = earnedHas(trophy);
  tick.setAttribute('aria-label', 'Mark "' + shownName + '" as earned');
  tick.addEventListener('change', () => markTrophy(trophy.id, tick.checked));
  const tickArt = make('span', 'check-box');
  tickArt.append(fromTemplate('tpl-icon-check'));
  tickWrap.append(tick, tickArt);
  if (trophy.grade === 'platinum') {
    const note = make('span', '', 'Earn the other ' + (guide.trophies.length - 1) + ' trophies first; the platinum then unlocks automatically.');
    note.id = 'platinum-hint';
    note.hidden = true;
    tick.setAttribute('aria-describedby', note.id);
    tick.addEventListener('click', (event) => event.preventDefault());
    tickWrap.append(note);
  }

  const body = make('button', 'trophy-main');
  body.type = 'button';
  body.setAttribute('aria-haspopup', 'dialog');
  body.setAttribute('aria-label', 'Open guide for ' + shownName);
  const headline = make('span', 'trophy-top');
  headline.append(gradeBadge(trophy.grade), make('span', 'trophy-name', shownName));
  if (trophy.missable) headline.append(missableBadge());
  if (masked) headline.append(hiddenBadge());
  headline.append(earnedBadge());
  const blurb = make('span', 'trophy-desc', masked ? MASK_DESC : trophy.description);
  const excerpt = make('span', 'trophy-excerpt', masked ? '' : trophy.guide);
  if (masked) excerpt.hidden = true;
  const meta = make('span', 'trophy-meta');
  meta.append(make('span', 'chip chip--id', slotLabel(trophy)), make('span', 'chip chip--kind', kindName(trophy.kind)));
  body.append(headline, blurb, excerpt, meta);
  body.addEventListener('click', () => detail.openAt(trophy.id));

  const arrow = make('span', 'trophy-chevron');
  arrow.setAttribute('aria-hidden', 'true');
  arrow.append(sprite('i-chevron-right'));

  row.append(tickWrap, body, arrow);
  return { row, tick };
}

function syncPlatinumRow() {
  if (!guide.platinum) return;
  const entry = rowIndex.get(guide.platinum.id);
  if (!entry) return;
  entry.tick.disabled = gateShut();
  entry.tick.checked = earnedHas(guide.platinum);
  entry.tick.title = gateHint();
  entry.row.dataset.earned = String(earnedHas(guide.platinum));
}

function paintListMeta(visible) {
  const earnedHere = visible.filter(earnedHas).length;
  dom['visible-count'].textContent = 'Showing ' + visible.length + ' of ' + guide.trophies.length + ' trophies (' + earnedHere + ' earned in this view)';
}

function paintChecklist() {
  const visible = visibleTrophies();
  rowIndex.clear();
  const fragment = document.createDocumentFragment();
  for (const trophy of visible) {
    const entry = checklistRow(trophy);
    rowIndex.set(trophy.id, entry);
    fragment.append(entry.row);
  }
  dom['trophy-list'].replaceChildren(fragment);
  syncPlatinumRow();
  paintListMeta(visible);
  const notes = activeFilterNotes();
  dom['clear-filters'].hidden = notes.length === 0;
  dom['empty-state'].hidden = visible.length !== 0;
  if (!visible.length) {
    dom['empty-text'].textContent = notes.length
      ? 'No trophies match ' + notes.join(', ') + '. Try a shorter search or clear the filters.'
      : 'No trophies match these filters.';
  }
}

function markTrophy(id, earned) {
  const trophy = guide.byId.get(id);
  if (!trophy) return;
  if (trophy.grade === 'platinum') {
    const entry = rowIndex.get(id);
    if (entry) entry.tick.checked = earnedHas(trophy);
    if (detail.isOpen() && detail.currentId() === id) dom['detail-earned'].checked = earnedHas(trophy);
    return;
  }
  if (earned) session.earned.add(id);
  else session.earned.delete(id);
  enforcePlatinumGate();
  persist();
  paintSummary();
  paintGradeChips();
  if (session.filters.hideCompleted || (session.spoiler && trophy.kind === 'story')) {
    paintChecklist();
  } else {
    const entry = rowIndex.get(id);
    if (entry) {
      entry.row.dataset.earned = String(earned);
      entry.tick.checked = earned;
      if (concealed(trophy)) entry.row.dataset.locked = 'true';
      else delete entry.row.dataset.locked;
    }
    syncPlatinumRow();
    paintListMeta([...rowIndex.keys()].map((key) => guide.byId.get(key)));
  }
  paintRoadmap();
  if (detail.isOpen() && detail.currentId() === id) detail.paint();
  if (earned && session.earned.size === guide.trophies.length) toast('Platinum earned. Leonida legend!');
}

const detail = {
  order: [],
  cursor: 0,
  revealed: new Set(),
  isOpen() {
    return dom['detail-dialog'].open;
  },
  currentId() {
    return this.order[this.cursor];
  },
  openAt(id) {
    const visible = visibleTrophies();
    const pool = visible.some((trophy) => trophy.id === id) ? visible : guide.trophies;
    this.order = pool.map((trophy) => trophy.id);
    this.cursor = Math.max(0, this.order.indexOf(id));
    this.paint();
    if (!this.isOpen()) dom['detail-dialog'].showModal();
  },
  step(offset) {
    const next = this.cursor + offset;
    if (next < 0 || next >= this.order.length) return;
    this.cursor = next;
    this.paint();
  },
  paint() {
    const trophy = guide.byId.get(this.currentId());
    if (!trophy) return;
    const masked = concealed(trophy) && !this.revealed.has(trophy.id);
    dom['detail-title'].textContent = masked ? MASK_NAME : trophy.name;
    dom['detail-desc'].textContent = masked ? MASK_DESC : trophy.description;
    const badges = dom['detail-badges'];
    badges.replaceChildren(
      gradeBadge(trophy.grade),
      make('span', 'chip chip--kind', kindName(trophy.kind)),
      make('span', 'chip chip--id', slotLabel(trophy))
    );
    if (trophy.missable) badges.append(missableBadge());
    if (earnedHas(trophy)) badges.append(labelledBadge('chip', 'tpl-icon-check', 'Earned'));
    dom['detail-locked'].hidden = !masked;
    dom['detail-content'].hidden = masked;
    dom['detail-guide'].textContent = masked ? '' : trophy.guide;
    const steps = masked ? [] : trophy.steps || [];
    const tips = masked ? [] : trophy.tips || [];
    const sources = masked ? [] : trophy.sources || [];
    const stepsList = dom['trophy-steps'];
    stepsList.replaceChildren();
    for (const step of steps) stepsList.append(make('li', '', step));
    dom['detail-steps-section'].hidden = steps.length === 0;
    const tipsList = dom['detail-tips'];
    tipsList.replaceChildren();
    for (const tip of tips) tipsList.append(make('li', '', tip));
    const sourcesList = dom['trophy-sources'];
    sourcesList.replaceChildren();
    for (const source of sources) sourcesList.append(sourceItem(source));
    dom['detail-sources-section'].hidden = sources.length === 0;
    const tick = dom['detail-earned'];
    tick.checked = earnedHas(trophy);
    tick.disabled = trophy.grade === 'platinum';
    tick.title = trophy.grade === 'platinum' ? gateHint() : '';
    dom['detail-position'].textContent = (this.cursor + 1) + ' / ' + this.order.length;
    dom['detail-prev'].disabled = this.cursor <= 0;
    dom['detail-next'].disabled = this.cursor >= this.order.length - 1;
  },
};

function roadmapChip(trophy) {
  const masked = concealed(trophy);
  const chip = make('button', 'tchip');
  chip.type = 'button';
  chip.dataset.grade = trophy.grade;
  chip.dataset.earned = String(earnedHas(trophy));
  chip.dataset.missable = String(trophy.missable === true);
  chip.dataset.hidden = String(masked);
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.setAttribute('aria-label', 'Open guide for ' + (masked ? MASK_NAME : trophy.name) + (earnedHas(trophy) ? ' (earned)' : ''));
  chip.append(
    make('span', 'dot'),
    fromTemplate('tpl-icon-check', 'check'),
    fromTemplate('tpl-icon-lock', 'chip-lock'),
    make('span', '', masked ? MASK_CHIP : trophy.name)
  );
  chip.addEventListener('click', () => detail.openAt(trophy.id));
  return chip;
}

function summaryPill(value, label) {
  const pill = make('span', 'summary-pill');
  pill.append(make('strong', '', value), document.createTextNode(' ' + label));
  return pill;
}

function stageCard(stage, position) {
  const names = stage.trophies || [];
  const matched = names.map((name) => guide.byName.get(name)).filter(Boolean);
  const done = matched.filter(earnedHas).length;
  const card = make('li', 'stage');
  if (matched.length && done === matched.length) card.classList.add('is-complete');

  const head = make('div', 'stage-head');
  head.append(make('span', 'stage-num', 'Stage ' + position));
  const titleWrap = make('div');
  titleWrap.append(make('h3', 'stage-title', stage.title));
  head.append(titleWrap);
  const tally = make('span', 'stage-progress');
  tally.append(document.createTextNode(done + ' / ' + matched.length));
  const mini = make('span', 'mini-bar');
  const fill = make('span');
  fill.style.width = matched.length ? Math.round((done / matched.length) * 100) + '%' : '0%';
  mini.append(fill);
  tally.append(mini);
  head.append(tally);
  card.append(head, make('p', 'stage-why', stage.why));

  const chips = make('div', 'chips');
  for (const name of names) {
    const trophy = guide.byName.get(name);
    chips.append(trophy ? roadmapChip(trophy) : make('span', 'chip', name));
  }
  card.append(chips);
  return card;
}

function paintRoadmap() {
  const root = dom['roadmap-root'];
  root.replaceChildren();
  const plan = guide.roadmap;
  if (!plan) return;

  const head = make('div', 'roadmap-head');
  const intro = make('div');
  intro.append(
    make('h2', 'roadmap-title', 'The road to the platinum'),
    make('p', 'roadmap-sub', 'Six stages from the first mission to "' + (plan.platinum || 'the platinum') + '". Work top to bottom, keep the two missables safe, then sweep the map. Ticks here and in the checklist share one save.')
  );
  const summary = make('div', 'roadmap-summary');
  summary.append(
    summaryPill(guide.trophies.length, 'trophies'),
    summaryPill(session.earned.size, 'earned'),
    summaryPill((plan.missables || []).length, 'missables'),
    summaryPill((plan.stages || []).length, 'stages')
  );
  head.append(intro, summary);
  root.append(head);

  const stages = make('ol', 'stages');
  (plan.stages || []).forEach((stage, index) => stages.append(stageCard(stage, index + 1)));
  root.append(stages);

  const missables = make('section', 'info-card info-card--warn');
  const missablesTitle = make('h3');
  missablesTitle.append(fromTemplate('tpl-icon-warning'), document.createTextNode('Missable trophies'));
  missables.append(missablesTitle, make('p', '', 'These can be lost for good if their story window closes. Keep a manual save before each one and do not overwrite it until the trophy has popped.'));
  const missableChips = make('div', 'chips');
  for (const name of plan.missables || []) {
    const trophy = guide.byName.get(name);
    if (trophy) missableChips.append(roadmapChip(trophy));
  }
  missables.append(missableChips);
  root.append(missables);

  const notes = make('section', 'info-card');
  const notesTitle = make('h3');
  notesTitle.append(sprite('i-info'), document.createTextNode('Route notes'));
  const notesList = make('ul', 'notes-list');
  for (const note of plan.notes || []) notesList.append(make('li', '', note));
  notes.append(notesTitle, notesList);
  root.append(notes);

  root.append(make('p', 'roadmap-foot', 'Every chip opens the full guide. Progress lives in this browser; export a JSON backup before clearing site data.'));
}

let searchTimer = 0;
let toastTimer = 0;

function toast(message) {
  const node = dom['toast'];
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), TOAST_LINGER_MS);
}

function setView(view) {
  if (!VIEW_NAMES.includes(view)) view = 'checklist';
  session.view = view;
  persist();
  for (const name of VIEW_NAMES) {
    const selected = name === view;
    const tab = dom['tab-' + name];
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    dom['panel-' + name].hidden = !selected;
  }
}

function setSpoiler(on) {
  session.spoiler = on;
  detail.revealed.clear();
  persist();
  syncFilterControls();
  paintChecklist();
  paintRoadmap();
  if (detail.isOpen()) detail.paint();
}

function resetFilters() {
  clearTimeout(searchTimer);
  session.filters = blankFilters();
  persist();
  syncFilterControls();
  paintGradeChips();
  paintChecklist();
  toast('Filters cleared');
}

function exportProgress() {
  const payload = {
    app: 'gta6-trophy-guide',
    version: 1,
    exportedAt: new Date().toISOString(),
    total: guide.trophies.length,
    earned: sortedEarned(),
    spoiler: session.spoiler,
    filters: session.filters,
    tab: session.view,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gta6-trophy-progress.json';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Progress exported');
}

function decodeImport(text) {
  const raw = JSON.parse(text);
  const payload = Array.isArray(raw) ? { earned: raw } : raw;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.earned)) {
    throw new Error('expected an object with an "earned" array of trophy ids');
  }
  const earned = new Set();
  for (const entry of payload.earned) {
    const id = coerceId(entry);
    if (!Number.isInteger(id) || !guide.knownIds.has(id)) throw new Error('unknown trophy id ' + JSON.stringify(entry));
    earned.add(id);
  }
  return {
    earned,
    spoiler: payload.spoiler === true,
    filters: cleanFilters(payload.filters),
    view: VIEW_NAMES.includes(payload.tab) ? payload.tab : session.view,
  };
}

async function importProgress(file) {
  try {
    const parsed = decodeImport(await file.text());
    session.earned = parsed.earned;
    enforcePlatinumGate();
    session.spoiler = parsed.spoiler;
    session.filters = parsed.filters;
    session.view = parsed.view;
    persist();
    syncFilterControls();
    paintSummary();
    paintGradeChips();
    paintChecklist();
    paintRoadmap();
    setView(parsed.view);
    if (detail.isOpen()) detail.paint();
    toast('Imported ' + session.earned.size + ' earned trophies');
  } catch (error) {
    toast('Import failed: ' + (error && error.message ? error.message : 'invalid file'));
  }
}

function resetProgress() {
  session.earned = new Set();
  persist();
  dom['reset-dialog'].close();
  paintSummary();
  paintGradeChips();
  paintChecklist();
  paintRoadmap();
  if (detail.isOpen()) detail.paint();
  toast('Progress reset');
}

function wireEvents() {
  dom['tab-checklist'].addEventListener('click', () => setView('checklist'));
  dom['tab-roadmap'].addEventListener('click', () => setView('roadmap'));
  dom['tabs'].addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = session.view === 'checklist' ? 'roadmap' : 'checklist';
    setView(next);
    dom['tab-' + next].focus();
  });

  dom['search'].addEventListener('input', (event) => {
    const value = event.target.value;
    dom['search-clear'].hidden = value.length === 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      session.filters.query = value;
      persist();
      syncFilterControls();
      paintChecklist();
    }, SEARCH_DEBOUNCE_MS);
  });
  dom['search-clear'].addEventListener('click', () => {
    clearTimeout(searchTimer);
    session.filters.query = '';
    persist();
    syncFilterControls();
    paintChecklist();
    dom['search'].focus();
  });
  dom['grade-filter'].addEventListener('change', (event) => {
    session.filters.grade = event.target.value;
    persist();
    syncFilterControls();
    paintGradeChips();
    paintChecklist();
  });
  dom['kind-filter'].addEventListener('change', (event) => {
    session.filters.kind = event.target.value;
    persist();
    syncFilterControls();
    paintChecklist();
  });
  dom['hide-completed'].addEventListener('change', (event) => {
    session.filters.hideCompleted = event.target.checked;
    persist();
    syncFilterControls();
    paintChecklist();
  });
  dom['missables-only'].addEventListener('change', (event) => {
    session.filters.missablesOnly = event.target.checked;
    persist();
    syncFilterControls();
    paintChecklist();
  });
  dom['spoiler-toggle'].addEventListener('change', (event) => setSpoiler(event.target.checked));
  dom['clear-filters'].addEventListener('click', resetFilters);
  dom['empty-clear'].addEventListener('click', resetFilters);

  dom['export-btn'].addEventListener('click', exportProgress);
  dom['import-btn'].addEventListener('click', () => dom['import-file'].click());
  dom['import-file'].addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importProgress(file);
  });

  dom['reset-btn'].addEventListener('click', () => dom['reset-dialog'].showModal());
  dom['reset-cancel'].addEventListener('click', () => dom['reset-dialog'].close());
  dom['reset-confirm'].addEventListener('click', resetProgress);
  dom['reset-dialog'].addEventListener('click', (event) => {
    if (event.target === dom['reset-dialog']) dom['reset-dialog'].close();
  });

  dom['detail-close'].addEventListener('click', () => dom['detail-dialog'].close());
  dom['detail-prev'].addEventListener('click', () => detail.step(-1));
  dom['detail-next'].addEventListener('click', () => detail.step(1));
  dom['detail-reveal'].addEventListener('click', () => {
    const id = detail.currentId();
    if (id === undefined) return;
    detail.revealed.add(id);
    detail.paint();
  });
  dom['detail-earned'].addEventListener('change', (event) => {
    const id = detail.currentId();
    if (id !== undefined) markTrophy(id, event.target.checked);
  });
  dom['detail-dialog'].addEventListener('click', (event) => {
    if (event.target === dom['detail-dialog']) dom['detail-dialog'].close();
  });
  dom['detail-dialog'].addEventListener('close', () => detail.revealed.clear());

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (detail.isOpen() || dom['reset-dialog'].open) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    event.preventDefault();
    setView('checklist');
    dom['search'].focus();
    dom['search'].select();
  });
}

async function loadGuideData() {
  const [trophyResponse, roadmapResponse] = await Promise.all([
    fetch('./data/trophies.json'),
    fetch('./data/roadmap.json'),
  ]);
  if (!trophyResponse.ok) throw new Error('trophies.json returned HTTP ' + trophyResponse.status);
  if (!roadmapResponse.ok) throw new Error('roadmap.json returned HTTP ' + roadmapResponse.status);
  const trophyDoc = await trophyResponse.json();
  const roadmapDoc = await roadmapResponse.json();
  if (!trophyDoc || !Array.isArray(trophyDoc.trophies) || trophyDoc.trophies.length === 0) {
    throw new Error('trophies.json has no trophy list');
  }
  guide.trophies = trophyDoc.trophies.slice().sort((left, right) => Number(left.grade === 'platinum') - Number(right.grade === 'platinum') || left.id - right.id);
  guide.platinum = guide.trophies.find((trophy) => trophy.grade === 'platinum') || null;
  guide.roadmap = roadmapDoc && typeof roadmapDoc === 'object' ? roadmapDoc : null;
  guide.byId = new Map(guide.trophies.map((trophy) => [trophy.id, trophy]));
  guide.byName = new Map(guide.trophies.map((trophy) => [trophy.name, trophy]));
  guide.knownIds = new Set(guide.byId.keys());
}

async function boot() {
  try {
    await loadGuideData();
  } catch (error) {
    dom['boot'].hidden = true;
    dom['boot-error'].hidden = false;
    dom['boot-error-text'].textContent = 'Could not load the guide data: ' + (error && error.message ? error.message : 'unknown error') + '.';
    return;
  }
  readSavedState();
  wireEvents();
  syncFilterControls();
  paintSummary();
  paintGradeChips();
  paintChecklist();
  paintRoadmap();
  setView(session.view);
  dom['boot'].hidden = true;
}

boot();
