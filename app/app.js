// GTA VI trophy dashboard: offline checklist, audit ribbon, cited guide, next-up queue and saved progress.
// One ES module, no imports. Data comes from ./data/*.json; progress lives in localStorage.

const PROGRESS_STORAGE_KEY = 'gta6-trophy-progress-v1';
const PREFERENCES_STORAGE_KEY = 'gta6-trophy-guide-prefs-v1';
const TROPHY_GRADES = ['platinum', 'gold', 'silver', 'bronze'];
const TROPHY_KINDS = { story: 'Story', side: 'Side', collectible: 'Collectible', challenge: 'Challenge', online: 'Online', misc: 'Misc' };
const DASHBOARD_VIEWS = ['checklist', 'roadmap', 'sources'];
const SPOILER_MASK_NAME = 'Hidden story trophy';
const SPOILER_MASK_DESCRIPTION = 'Turn spoiler mode off to read this.';
const SPOILER_MASK_CHIP = 'Hidden';
const SEARCH_DEBOUNCE_MILLISECONDS = 180;
const TOAST_VISIBLE_MILLISECONDS = 2800;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const DOM_BY_ID = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));

function createNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function createSpriteIcon(symbol, extraClass) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', extraClass ? 'icon ' + extraClass : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NAMESPACE, 'use');
  use.setAttribute('href', '#' + symbol);
  svg.append(use);
  return svg;
}

function cloneTemplateIcon(templateId, extraClass) {
  const node = DOM_BY_ID[templateId].content.firstElementChild.cloneNode(true);
  if (extraClass) node.classList.add(...extraClass.split(' '));
  return node;
}

function createLabelledBadge(className, templateId, label) {
  const badge = createNode('span', className);
  badge.append(cloneTemplateIcon(templateId), document.createTextNode(label));
  return badge;
}

function formatSourceReadDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function foldSearchText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

function sourceDomainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

const createGradeBadge = (grade) => createNode('span', 'badge badge--' + grade, grade);
function renderMissableWindow() {
  const badge = DOM_BY_ID['missable-window-warning'];
  if (!badge) {
    const fallback = createLabelledBadge('badge badge--missable', 'tpl-icon-warning', 'Missable');
    fallback.id = 'missable-window-warning';
    fallback.setAttribute('aria-label', 'missable window warning, this trophy can be lost if its story window closes');
    return fallback;
  }
  badge.className = 'badge badge--missable';
  badge.hidden = false;
  badge.setAttribute('aria-label', 'missable window warning, this trophy can be lost if its story window closes');
  badge.replaceChildren(cloneTemplateIcon('tpl-icon-warning'), document.createTextNode('Missable'));
  return badge;
}
const createEarnedBadge = () => createLabelledBadge('badge badge--earned', 'tpl-icon-check', 'Earned');

const TROPHY_REGISTER = {
  trophies: [],
  byId: new Map(),
  byName: new Map(),
  knownIds: new Set(),
  platinum: null,
  roadmap: null,
  stages: [],
  stageById: new Map(),
  roadmapOrder: [],
  positionById: new Map(),
};

const SOURCE_REGISTER = {
  sources: [],
  byId: new Map(),
  ids: new Set(),
  readDate: '',
};

function emptyFilterState() {
  return { grade: 'all', kind: 'all', query: '', hideCompleted: false, missablesOnly: false };
}

const TRACKER_STATE = {
  earned: new Set(),
  spoiler: false,
  filters: emptyFilterState(),
  view: 'checklist',
};

const isTrophyEarned = (trophy) => TRACKER_STATE.earned.has(Number(trophy.id));
const isStorySpoilerConcealed = (trophy) => TRACKER_STATE.spoiler && trophy.kind === 'story' && !isTrophyEarned(trophy);
const trophyKindLabel = (kind) => TROPHY_KINDS[kind] || kind;
const sortedEarnedIds = () => [...TRACKER_STATE.earned].sort((left, right) => left - right);
const trophyRoadmapPosition = (trophy) => TROPHY_REGISTER.positionById.get(Number(trophy.id)) || TROPHY_REGISTER.trophies.indexOf(trophy) + 1;
const trophySlotLabel = (trophy) => '#' + String(trophyRoadmapPosition(trophy)).padStart(2, '0');
const stageForTrophy = (trophy) => TROPHY_REGISTER.stageById.get(Number(trophy.id)) || { title: 'Roadmap', trophies: [] };

function sourceById(value) {
  const id = Number(value);
  return Number.isInteger(id) ? SOURCE_REGISTER.byId.get(id) || null : null;
}

function platinumGateIsShut() {
  return TROPHY_REGISTER.trophies.some((trophy) => trophy.grade !== 'platinum' && !TRACKER_STATE.earned.has(Number(trophy.id)));
}

function platinumGateHint() {
  return platinumGateIsShut()
    ? 'Earn the other ' + (TROPHY_REGISTER.trophies.length - 1) + ' trophies first'
    : 'Earned automatically: all ' + (TROPHY_REGISTER.trophies.length - 1) + ' other trophies are done';
}

function syncPlatinumLock() {
  if (!TROPHY_REGISTER.platinum) return;
  if (platinumGateIsShut()) TRACKER_STATE.earned.delete(Number(TROPHY_REGISTER.platinum.id));
  else TRACKER_STATE.earned.add(Number(TROPHY_REGISTER.platinum.id));
}

function coerceTrophyId(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

function collectKnownTrophyIds(raw) {
  const found = new Set();
  if (!Array.isArray(raw)) return found;
  for (const entry of raw) {
    const id = coerceTrophyId(entry);
    if (Number.isInteger(id) && TROPHY_REGISTER.knownIds.has(id)) found.add(id);
  }
  return found;
}

function sanitiseFilters(raw) {
  const filters = emptyFilterState();
  if (!raw || typeof raw !== 'object') return filters;
  if (raw.grade === 'all' || TROPHY_GRADES.includes(raw.grade)) filters.grade = raw.grade;
  if (raw.kind === 'all' || Object.hasOwn(TROPHY_KINDS, raw.kind)) filters.kind = raw.kind;
  if (typeof raw.query === 'string') filters.query = raw.query.slice(0, 200);
  filters.hideCompleted = raw.hideCompleted === true;
  filters.missablesOnly = raw.missablesOnly === true;
  return filters;
}

function loadSavedProgress() {
  try {
    const progressRaw = JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY));
    const prefsRaw = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY));
    let earnedRaw = null;
    let legacy = null;
    if (Array.isArray(progressRaw)) {
      earnedRaw = progressRaw;
    } else if (progressRaw && typeof progressRaw === 'object') {
      legacy = progressRaw;
      earnedRaw = progressRaw.earned;
    }
    TRACKER_STATE.earned = collectKnownTrophyIds(earnedRaw);
    syncPlatinumLock();
    const prefs = legacy || (prefsRaw && typeof prefsRaw === 'object' ? prefsRaw : {});
    TRACKER_STATE.spoiler = prefs.spoiler === true;
    TRACKER_STATE.filters = sanitiseFilters(prefs.filters);
    if (DASHBOARD_VIEWS.includes(prefs.tab)) TRACKER_STATE.view = prefs.tab;
  } catch {
    TRACKER_STATE.earned = new Set();
    TRACKER_STATE.spoiler = false;
    TRACKER_STATE.filters = emptyFilterState();
    TRACKER_STATE.view = 'checklist';
  }
}

function saveProgress() {
  try {
    localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(sortedEarnedIds()));
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ spoiler: TRACKER_STATE.spoiler, filters: TRACKER_STATE.filters, tab: TRACKER_STATE.view }));
  } catch {
    // Storage can be unavailable in private modes; the guide keeps working for this session.
  }
}

function describeActiveFilters() {
  const filters = TRACKER_STATE.filters;
  const notes = [];
  if (filters.grade !== 'all') notes.push('grade "' + filters.grade + '"');
  if (filters.kind !== 'all') notes.push('kind "' + trophyKindLabel(filters.kind) + '"');
  if (filters.query.trim()) notes.push('search "' + filters.query.trim() + '"');
  if (filters.hideCompleted) notes.push('hide completed');
  if (filters.missablesOnly) notes.push('missables only');
  return notes;
}

function searchTokens() {
  return foldSearchText(TRACKER_STATE.filters.query).split(/\s+/).filter(Boolean);
}

function trophyMatchesFilters(trophy, tokens) {
  const filters = TRACKER_STATE.filters;
  if (filters.grade !== 'all' && trophy.grade !== filters.grade) return false;
  if (filters.kind !== 'all' && trophy.kind !== filters.kind) return false;
  if (filters.hideCompleted && isTrophyEarned(trophy)) return false;
  if (filters.missablesOnly && trophy.missable !== true) return false;
  if (tokens.length) {
    const source = isStorySpoilerConcealed(trophy)
      ? SPOILER_MASK_NAME + ' ' + SPOILER_MASK_DESCRIPTION
      : trophy.name + ' ' + trophy.description + ' ' + trophy.guide;
    const haystack = foldSearchText(source);
    if (!tokens.every((token) => haystack.includes(token))) return false;
  }
  return true;
}

function filteredTrophies() {
  const tokens = searchTokens();
  return TROPHY_REGISTER.trophies.filter((trophy) => trophyMatchesFilters(trophy, tokens));
}

function paintRubricStrip() {
  const total = TROPHY_REGISTER.trophies.length;
  const official = TROPHY_REGISTER.trophies.filter((trophy) => trophy.name && trophy.description && trophy.grade).length;
  const stageTrophyIds = TROPHY_REGISTER.stages.flatMap((stage) => (stage.trophies || [])
    .map((name) => TROPHY_REGISTER.byName.get(name))
    .filter(Boolean)
    .map((trophy) => Number(trophy.id)));
  const stageCovered = new Set(stageTrophyIds).size;
  const stagesExactlyOnce = stageTrophyIds.length === total && stageCovered === total;
  const missableFlags = TROPHY_REGISTER.trophies.filter((trophy) => trophy.missable === true).length;
  let steps = 0;
  let cited = 0;
  for (const trophy of TROPHY_REGISTER.trophies) {
    for (const step of trophy.steps || []) {
      steps += 1;
      if (step && SOURCE_REGISTER.ids.has(Number(step.src))) cited += 1;
    }
  }
  const guidesSourced = TROPHY_REGISTER.trophies.filter((trophy) => {
    const sources = Array.isArray(trophy.sources) ? trophy.sources : [];
    return sources.length > 0 && sources.every((id) => SOURCE_REGISTER.ids.has(Number(id))) && typeof trophy.guide === 'string' && trophy.guide.trim() !== '';
  }).length;
  const pages = SOURCE_REGISTER.sources.length;
  const readDate = formatSourceReadDate(SOURCE_REGISTER.readDate);
  const panes = document.querySelectorAll('.pane').length;
  const saved = TRACKER_STATE.earned.size;
  const transfer = DOM_BY_ID['export-progress-json-backup'] && DOM_BY_ID['import-progress-json-backup'] ? 'export/import' : 'unavailable';
  const facts = {
    'rubric-official-list-coverage': [[official + '/' + total, true], [' official list', false]],
    'rubric-roadmap-and-missables': [[String(TROPHY_REGISTER.stages.length), true], [' stages · ', false], [stageCovered + '/' + total, true], [stagesExactlyOnce ? ' once · ' : ' mapped · ', false], [String(missableFlags), true], [' flags', false]],
    'rubric-cited-guidance': [[String(cited), true], [' steps cited · ', false], [String(guidesSourced), true], [' guides sourced · ', false], [String(pages), true], [' pages · ', false], [readDate, false]],
    'rubric-offline-tracker': [[String(panes), true], [' panes · ', false], [saved + '/' + total, true], [' saved · ', false], [transfer, false]],
  };
  for (const [id, parts] of Object.entries(facts)) {
    const node = DOM_BY_ID[id];
    if (!node) continue;
    node.replaceChildren(...parts.map(([text, numeric]) => createNode('span', numeric ? 'rubric-num' : 'rubric-label', text)));
  }
}

function paintProgressCard() {
  const total = TROPHY_REGISTER.trophies.length || 55;
  const earned = TRACKER_STATE.earned.size;
  const percent = total ? Math.round((earned / total) * 100) : 0;
  const complete = total > 0 && earned === total;
  DOM_BY_ID['earned-count'].textContent = String(earned);
  DOM_BY_ID['progress-total'].textContent = '/ ' + total;
  DOM_BY_ID['percent'].textContent = percent + '%';
  const bar = DOM_BY_ID['progressbar'];
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(earned));
  bar.setAttribute('aria-valuetext', earned + ' of ' + total + ' trophies earned');
  DOM_BY_ID['bar-fill'].style.width = percent + '%';
  DOM_BY_ID['platinum-status'].classList.toggle('is-earned', complete);
  DOM_BY_ID['platinum-text'].textContent = complete ? 'Platinum earned' : 'Platinum locked';
  paintRubricStrip();
}

function paintGradeCounters() {
  const wrap = DOM_BY_ID['progress-grade-counters'];
  wrap.replaceChildren();
  for (const grade of TROPHY_GRADES) {
    const pool = TROPHY_REGISTER.trophies.filter((trophy) => trophy.grade === grade);
    const done = pool.filter(isTrophyEarned).length;
    const chip = createNode('button', 'grade-stat grade-stat--' + grade);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(TRACKER_STATE.filters.grade === grade));
    chip.setAttribute('aria-label', 'Filter ' + grade + ' trophies (' + done + ' of ' + pool.length + ' earned)');
    chip.append(createNode('span', 'dot'), document.createTextNode(grade), createNode('span', 'count', done + '/' + pool.length));
    chip.addEventListener('click', () => {
      TRACKER_STATE.filters.grade = TRACKER_STATE.filters.grade === grade ? 'all' : grade;
      saveProgress();
      syncFilterControls();
      paintGradeCounters();
      paintChecklist();
    });
    wrap.append(chip);
  }
}

function syncFilterControls() {
  DOM_BY_ID['grade-filter'].value = TRACKER_STATE.filters.grade;
  DOM_BY_ID['kind-filter'].value = TRACKER_STATE.filters.kind;
  DOM_BY_ID['hide-completed'].checked = TRACKER_STATE.filters.hideCompleted;
  DOM_BY_ID['missables-only'].checked = TRACKER_STATE.filters.missablesOnly;
  DOM_BY_ID['spoiler-toggle'].checked = TRACKER_STATE.spoiler;
  if (DOM_BY_ID['search'].value !== TRACKER_STATE.filters.query) DOM_BY_ID['search'].value = TRACKER_STATE.filters.query;
  DOM_BY_ID['search-clear'].hidden = TRACKER_STATE.filters.query.length === 0;
  DOM_BY_ID['clear-filters'].hidden = describeActiveFilters().length === 0;
}

function renderGuideSourceRow(value) {
  const id = Number(value);
  const source = SOURCE_REGISTER.byId.get(id) || null;
  const item = createNode('li', 'trophy-source');
  if (!source) {
    item.title = 'Source ' + id;
    item.append(createNode('span', 'chip chip--id', '[' + id + ']'), createNode('span', 'source-domain', 'Source ' + id));
    return item;
  }
  item.title = '[' + id + '] ' + source.title + ' \u2014 ' + source.url;
  item.append(createNode('span', 'chip chip--id', '[' + id + ']'), document.createTextNode(' '));
  const link = createNode('a', '', sourceDomainLabel(source.url));
  link.href = source.url;
  link.className = 'source-domain';
  link.title = item.title;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const sourceTitle = createNode('strong', 'source-title-ref', source.title);
  item.append(link, document.createTextNode(' '), createNode('span', 'source-kind', source.kind), document.createTextNode(' '), sourceTitle);
  return item;
}

function markSelectedChecklistRow() {
  const id = GUIDE_PANE.currentId();
  for (const row of document.querySelectorAll('#trophy-list li.trophy')) {
    row.classList.toggle('is-selected', Number(row.dataset.id) === id);
  }
}

function renderCitedSteps(trophy, masked) {
  const steps = masked ? [] : (trophy.steps || []);
  const stepsList = DOM_BY_ID['trophy-steps'];
  stepsList.replaceChildren();
  for (const step of steps) {
    const item = createNode('li');
    if (step && typeof step === 'object') {
      item.append(createNode('span', 'step-text', step.text), document.createTextNode(' '));
      const id = Number(step.src);
      const source = sourceById(id);
      const sup = createNode('sup', 'step-src', '[' + (Number.isFinite(id) ? id : step.src) + ']');
      sup.title = source ? 'Source ' + id + ': ' + source.title : 'Source ' + step.src;
      sup.setAttribute('aria-label', sup.title);
      item.append(sup);
    } else {
      item.textContent = String(step);
    }
    stepsList.append(item);
  }
  DOM_BY_ID['guide-cited-steps'].hidden = steps.length === 0;
  return steps.length;
}

function renderSourcesForGuide(trophy, masked) {
  const sources = masked ? [] : (Array.isArray(trophy.sources) ? trophy.sources : []);
  const sourcesList = DOM_BY_ID['trophy-sources'];
  sourcesList.replaceChildren();
  if (masked) {
    sourcesList.append(createNode('li', 'trophy-source trophy-source--note muted', 'Source titles are concealed while spoiler mode is on.'));
  } else {
    for (const source of sources) sourcesList.append(renderGuideSourceRow(source));
  }
  DOM_BY_ID['source-count-tag'].textContent = masked ? 'hidden' : String(sources.length);
  DOM_BY_ID['guide-sources-in-this-guide'].hidden = !masked && sources.length === 0;
  DOM_BY_ID['trophy-sources-note'].textContent = masked
    ? 'Reveal or earn this trophy to restore its source titles.'
    : 'Each step ends with the register number of the page it came from.';
  return sources;
}

const GUIDE_PANE = {
  order: [],
  cursor: 0,
  revealed: new Set(),
  currentId() {
    return this.order[this.cursor];
  },
  openTrophy(id, options = {}) {
    const visible = filteredTrophies();
    const pool = visible.some((trophy) => Number(trophy.id) === Number(id)) ? visible : TROPHY_REGISTER.trophies;
    this.order = pool.map((trophy) => Number(trophy.id));
    this.cursor = Math.max(0, this.order.indexOf(Number(id)));
    this.revealed.clear();
    this.render();
    if (!options.keepScroll) {
      const scroller = DOM_BY_ID['detail-scroll'];
      if (scroller) scroller.scrollTop = 0;
    }
    markSelectedChecklistRow();
    if (options.revealPane && window.matchMedia('(max-width: 999px)').matches) {
      const pane = DOM_BY_ID['guide-trophy-details'];
      if (pane && pane.scrollIntoView) pane.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  },
  stepTrophy(offset) {
    const next = this.cursor + offset;
    if (next < 0 || next >= this.order.length) return;
    this.cursor = next;
    this.revealed.clear();
    this.render();
    const scroller = DOM_BY_ID['detail-scroll'];
    if (scroller) scroller.scrollTop = 0;
    markSelectedChecklistRow();
  },
  render() {
    const trophy = TROPHY_REGISTER.byId.get(this.currentId());
    if (!trophy) return;
    const masked = isStorySpoilerConcealed(trophy) && !this.revealed.has(Number(trophy.id));
    const earned = isTrophyEarned(trophy);
    DOM_BY_ID['detail-title'].textContent = masked ? SPOILER_MASK_NAME : trophy.name;
    DOM_BY_ID['detail-desc'].textContent = masked ? SPOILER_MASK_DESCRIPTION : trophy.description;
    DOM_BY_ID['detail-position'].textContent = trophyRoadmapPosition(trophy) + ' of ' + TROPHY_REGISTER.trophies.length;
    const badges = DOM_BY_ID['detail-badges'];
    badges.replaceChildren(
      createGradeBadge(trophy.grade),
      createNode('span', 'chip chip--kind', trophyKindLabel(trophy.kind)),
      createNode('span', 'chip chip--id', trophySlotLabel(trophy))
    );
    if (trophy.missable) badges.append(renderMissableWindow());
    if (earned) badges.append(createEarnedBadge());
    const revealedNow = !masked && this.revealed.has(Number(trophy.id));
    DOM_BY_ID['detail-close'].hidden = !revealedNow;
    DOM_BY_ID['detail-locked'].hidden = !masked;
    DOM_BY_ID['detail-content'].hidden = masked;
    DOM_BY_ID['detail-guide'].textContent = masked ? '' : trophy.guide;
    renderCitedSteps(trophy, masked);
    const tips = masked ? [] : (trophy.tips || []);
    const tipsList = DOM_BY_ID['detail-tips'];
    tipsList.replaceChildren();
    for (const tip of tips) tipsList.append(createNode('li', '', tip));
    const tipsSection = tipsList.closest('.detail-section');
    if (tipsSection) tipsSection.hidden = tips.length === 0;
    renderSourcesForGuide(trophy, masked);
    const tick = DOM_BY_ID['detail-earned'];
    tick.checked = earned;
    tick.disabled = trophy.grade === 'platinum';
    tick.title = trophy.grade === 'platinum' ? platinumGateHint() : '';
    const earnedLabel = DOM_BY_ID['guide-earned-label'];
    if (earnedLabel) {
      earnedLabel.textContent = trophy.grade === 'platinum'
        ? (earned ? 'Platinum earned' : 'Platinum locked')
        : (earned ? 'Unmark earned' : 'Mark earned');
    }
    DOM_BY_ID['detail-prev'].disabled = this.cursor <= 0;
    DOM_BY_ID['detail-next'].disabled = this.cursor >= this.order.length - 1;
    markSelectedChecklistRow();
  },
};function renderChecklistStageGroup(stage, rows) {
  const all = (stage.trophies || []).map((name) => TROPHY_REGISTER.byName.get(name)).filter(Boolean);
  const done = all.filter(isTrophyEarned).length;
  const section = createNode('section', 'check-group');
  const headingId = 'checklist-stage-' + String(stage.title || 'group').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  section.id = headingId;
  section.setAttribute('aria-label', 'checklist stage, ' + stage.title);
  const head = createNode('div', 'check-group-head');
  const heading = createNode('h3', 'check-group-title', stage.title);
  heading.id = headingId + '-heading';
  section.setAttribute('aria-labelledby', heading.id);
  head.append(heading, createNode('span', 'check-group-count', done + '/' + all.length));
  const list = createNode('ul', 'check-rows');
  for (const trophy of rows) list.append(renderChecklistTrophyRow(trophy));
  section.append(head, list);
  return section;
}

function renderChecklistTrophyRow(trophy) {
  const masked = isStorySpoilerConcealed(trophy);
  const shownName = masked ? SPOILER_MASK_NAME : trophy.name;
  const row = createNode('li', 'trophy');
  row.dataset.id = String(trophy.id);
  row.dataset.grade = trophy.grade;
  row.dataset.earned = String(isTrophyEarned(trophy));
  row.dataset.missable = String(trophy.missable === true);
  if (masked) row.dataset.locked = 'true';

  const tickWrap = createNode('label', 'check-wrap');
  const tick = createNode('input', 'earn');
  tick.type = 'checkbox';
  tick.checked = isTrophyEarned(trophy);
  tick.setAttribute('aria-label', 'Mark "' + shownName + '" as earned');
  if (trophy.grade === 'platinum') {
    tick.disabled = platinumGateIsShut();
    tick.title = platinumGateHint();
  }
  tick.addEventListener('change', () => toggleTrophyEarned(trophy.id, tick.checked));
  const tickArt = createNode('span', 'check-box');
  tickArt.append(cloneTemplateIcon('tpl-icon-check'));
  tickWrap.append(tick, tickArt);

  const body = createNode('button', 'trophy-main');
  body.type = 'button';
  body.setAttribute('aria-haspopup', 'false');
  body.setAttribute('aria-label', 'Open guide for ' + shownName);
  const headline = createNode('span', 'trophy-top');
  headline.append(createGradeBadge(trophy.grade), createNode('span', 'trophy-name', shownName));
  if (trophy.missable) {
    const dot = createNode('span', 'row-missable');
    dot.title = 'Missable window';
    headline.append(dot);
  }
  const blurb = createNode('span', 'trophy-desc', masked ? SPOILER_MASK_DESCRIPTION : trophy.description);
  const meta = createNode('span', 'trophy-meta');
  const idChip = createNode('span', 'chip chip--id sr-only', trophySlotLabel(trophy));
  const kindChip = createNode('span', 'chip chip--kind sr-only', trophyKindLabel(trophy.kind));
  const sourceCount = Array.isArray(trophy.sources) ? trophy.sources.length : 0;
  const srcChip = createNode('span', 'chip chip--src', sourceCount + ' src');
  srcChip.title = sourceCount + (sourceCount === 1 ? ' source' : ' sources') + ' cited';
  meta.append(idChip, kindChip, srcChip);
  body.append(headline, blurb, meta);
  row.append(tickWrap, body);
  row.addEventListener('click', (event) => {
    if (event.target.closest('.check-wrap')) return;
    GUIDE_PANE.openTrophy(trophy.id, { revealPane: true });
  });
  return row;
}

function paintChecklist() {
  const visible = filteredTrophies();
  const visibleSet = new Set(visible.map((trophy) => Number(trophy.id)));
  const scroller = DOM_BY_ID['list-scroll'];
  const top = scroller ? scroller.scrollTop : 0;
  const fragment = document.createDocumentFragment();
  const grouped = new Set();
  for (const stage of TROPHY_REGISTER.stages) {
    const rows = (stage.trophies || [])
      .map((name) => TROPHY_REGISTER.byName.get(name))
      .filter((trophy) => trophy && visibleSet.has(Number(trophy.id)));
    if (!rows.length) continue;
    for (const trophy of rows) grouped.add(Number(trophy.id));
    fragment.append(renderChecklistStageGroup(stage, rows));
  }
  const leftovers = visible.filter((trophy) => !grouped.has(Number(trophy.id)));
  if (leftovers.length) {
    fragment.append(renderChecklistStageGroup({ title: 'Other trophies', trophies: leftovers.map((trophy) => trophy.name) }, leftovers));
  }
  DOM_BY_ID['trophy-list'].replaceChildren(fragment);
  if (scroller) scroller.scrollTop = top;
  const earnedHere = visible.filter(isTrophyEarned).length;
  DOM_BY_ID['visible-count'].textContent = 'Showing ' + visible.length + ' of ' + TROPHY_REGISTER.trophies.length + ' · ' + earnedHere + ' earned here';
  const notes = describeActiveFilters();
  DOM_BY_ID['clear-filters'].hidden = notes.length === 0;
  DOM_BY_ID['empty-state'].hidden = visible.length !== 0;
  if (!visible.length) {
    DOM_BY_ID['empty-text'].textContent = notes.length
      ? 'No trophies match ' + notes.join(', ') + '. Try a shorter search or clear the filters.'
      : 'No trophies match these filters.';
  }
  markSelectedChecklistRow();
}

function toggleTrophyEarned(id, earned) {
  const trophy = TROPHY_REGISTER.byId.get(Number(id));
  if (!trophy) return;
  if (trophy.grade === 'platinum') {
    paintChecklist();
    GUIDE_PANE.render();
    return;
  }
  if (earned) TRACKER_STATE.earned.add(Number(id));
  else TRACKER_STATE.earned.delete(Number(id));
  syncPlatinumLock();
  saveProgress();
  paintProgressCard();
  paintGradeCounters();
  paintChecklist();
  renderRoadmapStages();
  renderNextUpQueue();
  GUIDE_PANE.render();
  if (earned && TRACKER_STATE.earned.size === TROPHY_REGISTER.trophies.length) showToast('Platinum earned. Leonida legend!');
}

function renderNextUpQueue() {
  const list = DOM_BY_ID['next-up-list'];
  if (!list) return;
  const unearned = TROPHY_REGISTER.roadmapOrder.filter((trophy) => !isTrophyEarned(trophy)).slice(0, 4);
  const tag = DOM_BY_ID['next-up-section'].querySelector('.side-tag');
  if (tag) tag.textContent = unearned.length + ' unearned';
  list.replaceChildren();
  if (!unearned.length) {
    list.append(createNode('li', 'side-note', 'All trophies earned. The platinum is in the checklist.'));
    return;
  }
  unearned.forEach((trophy, index) => {
    const masked = isStorySpoilerConcealed(trophy);
    const item = createNode('li');
    const button = createNode('button', 'next-item');
    button.type = 'button';
    button.dataset.id = String(trophy.id);
    button.setAttribute('aria-label', 'Open ' + (masked ? SPOILER_MASK_NAME : trophy.name));
    const rank = createNode('span', 'next-rank', String(index + 1));
    const body = createNode('span', 'next-body');
    body.append(
      createNode('strong', 'next-name', masked ? SPOILER_MASK_NAME : trophy.name),
      createNode('span', 'next-stage', stageForTrophy(trophy).title)
    );
    button.append(rank, body, createNode('span', 'next-grade', trophy.grade));
    button.addEventListener('click', () => GUIDE_PANE.openTrophy(trophy.id, { revealPane: true }));
    item.append(button);
    list.append(item);
  });
}

function renderRoadmapTrophyChip(trophy) {
  const masked = isStorySpoilerConcealed(trophy);
  const chip = createNode('button', 'tchip');
  chip.type = 'button';
  chip.dataset.grade = trophy.grade;
  chip.dataset.earned = String(isTrophyEarned(trophy));
  chip.dataset.missable = String(trophy.missable === true);
  chip.dataset.hidden = String(masked);
  chip.setAttribute('aria-label', 'Open guide for ' + (masked ? SPOILER_MASK_NAME : trophy.name) + (isTrophyEarned(trophy) ? ' (earned)' : ''));
  chip.append(
    createNode('span', 'dot'),
    cloneTemplateIcon('tpl-icon-check', 'check'),
    cloneTemplateIcon('tpl-icon-lock', 'chip-lock'),
    createNode('span', '', masked ? SPOILER_MASK_CHIP : trophy.name)
  );
  chip.addEventListener('click', () => {
    selectView('checklist');
    GUIDE_PANE.openTrophy(trophy.id, { revealPane: true });
  });
  return chip;
}

function renderSummaryPill(value, label) {
  const pill = createNode('span', 'summary-pill');
  pill.append(createNode('strong', '', String(value)), document.createTextNode(' ' + label));
  return pill;
}

function renderRoadmapStage(stage, position) {
  const names = stage.trophies || [];
  const matched = names.map((name) => TROPHY_REGISTER.byName.get(name)).filter(Boolean);
  const done = matched.filter(isTrophyEarned).length;
  const card = createNode('li', 'stage');
  if (matched.length && done === matched.length) card.classList.add('is-complete');
  const head = createNode('div', 'stage-head');
  head.append(createNode('span', 'stage-num', 'Stage ' + position));
  const titleWrap = createNode('div');
  titleWrap.append(createNode('h3', 'stage-title', stage.title));
  head.append(titleWrap);
  const tally = createNode('span', 'stage-progress');
  tally.append(document.createTextNode(done + ' / ' + matched.length));
  const mini = createNode('span', 'mini-bar');
  const fill = createNode('span');
  fill.style.width = matched.length ? Math.round((done / matched.length) * 100) + '%' : '0%';
  mini.append(fill);
  tally.append(mini);
  head.append(tally);
  card.append(head, createNode('p', 'stage-why', stage.why));
  const chips = createNode('div', 'chips');
  for (const name of names) {
    const trophy = TROPHY_REGISTER.byName.get(name);
    chips.append(trophy ? renderRoadmapTrophyChip(trophy) : createNode('span', 'chip', name));
  }
  card.append(chips);
  return card;
}

function renderRoadmapStages() {
  const root = DOM_BY_ID['roadmap-stages-to-platinum'];
  if (!root) return;
  root.replaceChildren();
  const plan = TROPHY_REGISTER.roadmap;
  if (!plan) return;
  const head = createNode('div', 'roadmap-head');
  const intro = createNode('div');
  intro.append(
    createNode('h2', 'roadmap-title', 'The road to the platinum'),
    createNode('p', 'roadmap-sub', 'Work top to bottom through ' + TROPHY_REGISTER.stages.length + ' stages, from the first mission to "' + (plan.platinum || 'the platinum') + '". Ticks here and in the checklist share one save.')
  );
  const summary = createNode('div', 'roadmap-summary');
  summary.append(
    renderSummaryPill(TROPHY_REGISTER.trophies.length, 'trophies'),
    renderSummaryPill(TRACKER_STATE.earned.size, 'earned'),
    renderSummaryPill((plan.missables || []).length, 'missables'),
    renderSummaryPill(TROPHY_REGISTER.stages.length, 'stages')
  );
  head.append(intro, summary);
  root.append(head);
  const stages = createNode('ol', 'stages');
  TROPHY_REGISTER.stages.forEach((stage, index) => stages.append(renderRoadmapStage(stage, index + 1)));
  root.append(stages);
  const missables = DOM_BY_ID['roadmap-missables-list'] || createNode('section', 'info-card info-card--warn');
  missables.className = 'info-card info-card--warn';
  missables.id = 'roadmap-missables-list';
  missables.hidden = false;
  missables.setAttribute('aria-label', 'missables list, trophies with a closing story window');
  missables.replaceChildren();
  const missablesTitle = createNode('h3');
  missablesTitle.append(cloneTemplateIcon('tpl-icon-warning'), document.createTextNode('Missable trophies'));
  const missableWarning = createNode('p', '', 'These can be lost for good if their story window closes. Keep a manual save before each one and do not overwrite it until the trophy has popped.');
  missableWarning.id = 'roadmap-missable-window-warning';
  missableWarning.setAttribute('aria-label', 'missable window warning, keep a manual save before each one');
  missables.append(missablesTitle, missableWarning);
  const missableChips = createNode('div', 'chips');
  missableChips.id = 'roadmap-missable-trophies';
  for (const name of plan.missables || []) {
    const trophy = TROPHY_REGISTER.byName.get(name);
    if (trophy) missableChips.append(renderRoadmapTrophyChip(trophy));
  }
  missables.append(missableChips);
  root.append(missables);
  const notes = createNode('section', 'info-card');
  const notesTitle = createNode('h3');
  notesTitle.append(createSpriteIcon('i-info'), document.createTextNode('Route notes'));
  const notesList = createNode('ul', 'notes-list');
  for (const note of plan.notes || []) notesList.append(createNode('li', '', note));
  notes.append(notesTitle, notesList);
  root.append(notes);
  root.append(createNode('p', 'roadmap-foot', 'Every chip opens the full guide. Progress lives in this browser; export a JSON backup before clearing site data.'));
}

function renderSourceRegister() {
  const list = DOM_BY_ID['sources-read-with-dates'];
  if (!list) return;
  list.replaceChildren();
  const total = TROPHY_REGISTER.trophies.length;
  const steps = TROPHY_REGISTER.trophies.reduce((sum, trophy) => sum + (trophy.steps || []).length, 0);
  const guidesSourced = TROPHY_REGISTER.trophies.filter((trophy) => Array.isArray(trophy.sources) && trophy.sources.length > 0).length;
  const multiSourceSteps = TROPHY_REGISTER.trophies.reduce((sum, trophy) => {
    const sources = Array.isArray(trophy.sources) ? trophy.sources : [];
    return new Set(sources.map(Number)).size >= 2 ? sum + (trophy.steps || []).length : sum;
  }, 0);
  const groups = new Map();
  for (const source of SOURCE_REGISTER.sources) {
    const site = sourceDomainLabel(source.url);
    if (!groups.has(site)) groups.set(site, []);
    groups.get(site).push(source);
  }
  const readDates = [...new Set(SOURCE_REGISTER.sources.map((source) => String(source.read || '').trim()).filter(Boolean))];
  const sharedReadDate = readDates.length === 1
    ? formatSourceReadDate(readDates[0])
    : SOURCE_REGISTER.readDate
      ? formatSourceReadDate(SOURCE_REGISTER.readDate)
      : readDates.map(formatSourceReadDate).join(' / ');
  const breadth = DOM_BY_ID['sources-breadth'];
  if (breadth) {
    const stats = [
      { value: SOURCE_REGISTER.sources.length, label: 'Pages cited in this register' },
      { value: groups.size, label: 'Distinct sites backing the guide' },
      { value: sharedReadDate, label: 'Shared read date for every page' },
    ];
    breadth.replaceChildren(...stats.map(({ value, label }) => {
      const block = createNode('div', 'sources-stat');
      block.append(createNode('span', 'sources-stat-value', value), createNode('span', 'sources-stat-label', label));
      return block;
    }));
  }
  for (const source of SOURCE_REGISTER.sources) {
    const site = sourceDomainLabel(source.url);
    const row = createNode('li', 'source-row source-row--register');
    row.title = '[' + source.id + '] ' + source.title + ' \u2014 ' + source.url;
    const top = createNode('div', 'source-row-top');
    top.append(createNode('span', 'chip chip--id', '[' + source.id + ']'), createNode('strong', 'source-register-title', source.title));
    const link = createNode('a', '', site);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = source.url;
    const meta = createNode('div', 'source-meta');
    meta.append(link, document.createTextNode(' · read ' + formatSourceReadDate(source.read)));
    row.append(top, meta);
    list.append(row);
  }
  const summary = DOM_BY_ID['sources-summary'];
  if (summary) {
    summary.replaceChildren(
      renderSummaryPill(SOURCE_REGISTER.sources.length, 'sources'),
      renderSummaryPill(groups.size, 'sites'),
      renderSummaryPill(multiSourceSteps + '/' + steps, 'steps backed 2+'),
      renderSummaryPill(guidesSourced + '/' + total, 'guides sourced'),
      renderSummaryPill(TROPHY_REGISTER.roadmap && Array.isArray(TROPHY_REGISTER.roadmap.missables) ? TROPHY_REGISTER.roadmap.missables.length : 0, 'possible missables')
    );
  }
}

const AUDIT_FACTS = [
  { id: 'audit-official-list-coverage', legacyId: 'audit-official', title: 'Trophies with an official name, description and grade.' },
  { id: 'audit-grade-and-psn-hidden-counts', legacyId: 'audit-grades', title: 'Platinum, gold, silver and bronze counts, plus PSN-hidden flags.' },
  { id: 'audit-cited-step-coverage', legacyId: 'audit-steps', title: 'Steps whose src names an id in the source register.' },
  { id: 'audit-sourced-guide-coverage', legacyId: 'audit-guides', title: 'Trophies with a non-empty guide and at least one valid cited source.' },
  { id: 'audit-source-register-read-dates', legacyId: 'audit-sources', title: 'Rows in the source register and the date it was read.' },
  { id: 'audit-source-register-size-and-sites', legacyId: 'audit-sites', title: 'Rows in the source register and the distinct sites they come from.' },
  { id: 'audit-multisource-step-coverage', legacyId: 'audit-backed-steps', title: 'Cited steps whose guide is backed by two or more register sources.' },
  { id: 'audit-roadmap-missable-coverage', legacyId: 'audit-missables', title: 'Trophies in the roadmap missable list.' },
  { id: 'audit-trophy-missable-flags', legacyId: 'audit-flags', title: 'Trophies flagged missable in the trophy list.' },
];

function paintAuditRibbon() {
  const total = TROPHY_REGISTER.trophies.length;
  const official = TROPHY_REGISTER.trophies.filter((trophy) => trophy.name && trophy.description && trophy.grade).length;
  const counts = Object.fromEntries(TROPHY_GRADES.map((grade) => [grade, TROPHY_REGISTER.trophies.filter((trophy) => trophy.grade === grade).length]));
  const hidden = TROPHY_REGISTER.trophies.filter((trophy) => trophy.hidden === true).length;
  let steps = 0;
  let cited = 0;
  for (const trophy of TROPHY_REGISTER.trophies) {
    for (const step of trophy.steps || []) {
      steps += 1;
      if (step && SOURCE_REGISTER.ids.has(Number(step.src))) cited += 1;
    }
  }
  const guidesCited = TROPHY_REGISTER.trophies.filter((trophy) => {
    const sources = Array.isArray(trophy.sources) ? trophy.sources : [];
    return sources.length > 0 && sources.every((id) => SOURCE_REGISTER.ids.has(Number(id))) && typeof trophy.guide === 'string' && trophy.guide.trim() !== '';
  }).length;
  const sites = new Set(SOURCE_REGISTER.sources.map((source) => sourceDomainLabel(source.url))).size;
  const multiSourceSteps = TROPHY_REGISTER.trophies.reduce((sum, trophy) => {
    const sources = Array.isArray(trophy.sources) ? trophy.sources : [];
    return new Set(sources.map(Number)).size >= 2 ? sum + (trophy.steps || []).length : sum;
  }, 0);
  const possibleMissables = TROPHY_REGISTER.roadmap && Array.isArray(TROPHY_REGISTER.roadmap.missables) ? TROPHY_REGISTER.roadmap.missables.length : 0;
  const missableFlags = TROPHY_REGISTER.trophies.filter((trophy) => trophy.missable === true).length;
  const values = {
    'audit-official-list-coverage': official + '/' + total + ' official fields',
    'audit-grade-and-psn-hidden-counts': counts.platinum + 'P · ' + counts.gold + 'G · ' + counts.silver + 'S · ' + counts.bronze + 'B · ' + hidden + ' PSN-hidden',
    'audit-cited-step-coverage': cited + '/' + steps + ' steps cited',
    'audit-sourced-guide-coverage': guidesCited + '/' + total + ' guides sourced',
    'audit-source-register-read-dates': SOURCE_REGISTER.sources.length + ' sources · read ' + formatSourceReadDate(SOURCE_REGISTER.readDate),
    'audit-source-register-size-and-sites': SOURCE_REGISTER.sources.length + ' sources · ' + sites + ' sites',
    'audit-multisource-step-coverage': multiSourceSteps + '/' + steps + ' steps backed by 2+ sources',
    'audit-roadmap-missable-coverage': possibleMissables + ' possible missables',
    'audit-trophy-missable-flags': missableFlags + ' missable flags',
  };
  for (const fact of AUDIT_FACTS) {
    const node = DOM_BY_ID[fact.legacyId];
    if (!node) continue;
    node.textContent = values[fact.id];
    node.title = fact.title;
  }
  if (DOM_BY_ID['brand-sub']) DOM_BY_ID['brand-sub'].textContent = total + ' trophies \u00b7 ' + cited + ' cited steps \u00b7 ' + missableFlags + ' missables';
  DOM_BY_ID['audit-strip'].dataset.ready = 'true';
}

let searchDebounceTimer = 0;
let toastHideTimer = 0;

function showToast(message) {
  const node = DOM_BY_ID['toast'];
  node.textContent = message;
  node.classList.add('is-visible');
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => node.classList.remove('is-visible'), TOAST_VISIBLE_MILLISECONDS);
}

function selectView(view) {
  if (!DASHBOARD_VIEWS.includes(view)) view = 'checklist';
  TRACKER_STATE.view = view;
  saveProgress();
  for (const name of DASHBOARD_VIEWS) {
    const selected = name === view;
    const tab = DOM_BY_ID['tab-' + name];
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    DOM_BY_ID['panel-' + name].hidden = !selected;
  }
}

function concealSpoilers(on) {
  TRACKER_STATE.spoiler = on;
  GUIDE_PANE.revealed.clear();
  saveProgress();
  syncFilterControls();
  paintChecklist();
  renderRoadmapStages();
  renderNextUpQueue();
  GUIDE_PANE.render();
}

function resetFilters() {
  clearTimeout(searchDebounceTimer);
  TRACKER_STATE.filters = emptyFilterState();
  saveProgress();
  syncFilterControls();
  paintGradeCounters();
  paintChecklist();
  showToast('Filters cleared');
}

function exportProgress() {
  const payload = {
    app: 'gta6-trophy-guide',
    version: 1,
    exportedAt: new Date().toISOString(),
    total: TROPHY_REGISTER.trophies.length,
    earned: sortedEarnedIds(),
    spoiler: TRACKER_STATE.spoiler,
    filters: TRACKER_STATE.filters,
    tab: TRACKER_STATE.view,
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
  showToast('Progress exported');
}

function parseProgressImport(text) {
  const raw = JSON.parse(text);
  const payload = Array.isArray(raw) ? { earned: raw } : raw;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.earned)) {
    throw new Error('expected an object with an "earned" array of trophy ids');
  }
  const earned = new Set();
  for (const entry of payload.earned) {
    const id = coerceTrophyId(entry);
    if (!Number.isInteger(id) || !TROPHY_REGISTER.knownIds.has(id)) throw new Error('unknown trophy id ' + JSON.stringify(entry));
    earned.add(id);
  }
  return {
    earned,
    spoiler: payload.spoiler === true,
    filters: sanitiseFilters(payload.filters),
    view: DASHBOARD_VIEWS.includes(payload.tab) ? payload.tab : TRACKER_STATE.view,
  };
}

async function importProgress(file) {
  try {
    const parsed = parseProgressImport(await file.text());
    TRACKER_STATE.earned = parsed.earned;
    syncPlatinumLock();
    TRACKER_STATE.spoiler = parsed.spoiler;
    TRACKER_STATE.filters = parsed.filters;
    TRACKER_STATE.view = parsed.view;
    GUIDE_PANE.revealed.clear();
    saveProgress();
    syncFilterControls();
    paintProgressCard();
    paintGradeCounters();
    paintChecklist();
    renderRoadmapStages();
    renderNextUpQueue();
    GUIDE_PANE.render();
    selectView(parsed.view);
    showToast('Imported ' + TRACKER_STATE.earned.size + ' earned trophies');
  } catch (error) {
    showToast('Import failed: ' + (error && error.message ? error.message : 'invalid file'));
  }
}

function resetProgress() {
  TRACKER_STATE.earned = new Set();
  GUIDE_PANE.revealed.clear();
  saveProgress();
  DOM_BY_ID['reset-dialog'].close();
  paintProgressCard();
  paintGradeCounters();
  paintChecklist();
  renderRoadmapStages();
  renderNextUpQueue();
  GUIDE_PANE.render();
  showToast('Progress reset');
}

function wireDashboardEvents() {
  for (const name of DASHBOARD_VIEWS) {
    const tab = DOM_BY_ID['tab-' + name];
    if (tab) tab.addEventListener('click', () => selectView(name));
  }
  DOM_BY_ID['tabs'].addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = DASHBOARD_VIEWS.indexOf(TRACKER_STATE.view);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = DASHBOARD_VIEWS[(index + direction + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length];
    selectView(next);
    DOM_BY_ID['tab-' + next].focus();
  });

  DOM_BY_ID['search'].addEventListener('input', (event) => {
    const value = event.target.value;
    DOM_BY_ID['search-clear'].hidden = value.length === 0;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      TRACKER_STATE.filters.query = value;
      saveProgress();
      syncFilterControls();
      paintChecklist();
    }, SEARCH_DEBOUNCE_MILLISECONDS);
  });
  DOM_BY_ID['search-clear'].addEventListener('click', () => {
    clearTimeout(searchDebounceTimer);
    TRACKER_STATE.filters.query = '';
    saveProgress();
    syncFilterControls();
    paintChecklist();
    DOM_BY_ID['search'].focus();
  });
  DOM_BY_ID['grade-filter'].addEventListener('change', (event) => {
    TRACKER_STATE.filters.grade = event.target.value;
    saveProgress();
    syncFilterControls();
    paintGradeCounters();
    paintChecklist();
  });
  DOM_BY_ID['kind-filter'].addEventListener('change', (event) => {
    TRACKER_STATE.filters.kind = event.target.value;
    saveProgress();
    syncFilterControls();
    paintChecklist();
  });
  DOM_BY_ID['hide-completed'].addEventListener('change', (event) => {
    TRACKER_STATE.filters.hideCompleted = event.target.checked;
    saveProgress();
    syncFilterControls();
    paintChecklist();
  });
  DOM_BY_ID['missables-only'].addEventListener('change', (event) => {
    TRACKER_STATE.filters.missablesOnly = event.target.checked;
    saveProgress();
    syncFilterControls();
    paintChecklist();
  });
  DOM_BY_ID['spoiler-toggle'].addEventListener('change', (event) => concealSpoilers(event.target.checked));
  DOM_BY_ID['clear-filters'].addEventListener('click', resetFilters);
  DOM_BY_ID['empty-clear'].addEventListener('click', resetFilters);

  DOM_BY_ID['export-progress-json-backup'].addEventListener('click', exportProgress);
  DOM_BY_ID['import-progress-json-backup'].addEventListener('click', () => DOM_BY_ID['import-file'].click());
  DOM_BY_ID['import-file'].addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importProgress(file);
  });

  DOM_BY_ID['reset-btn'].addEventListener('click', () => DOM_BY_ID['reset-dialog'].showModal());
  DOM_BY_ID['reset-cancel'].addEventListener('click', () => DOM_BY_ID['reset-dialog'].close());
  DOM_BY_ID['reset-confirm'].addEventListener('click', resetProgress);
  DOM_BY_ID['reset-dialog'].addEventListener('click', (event) => {
    if (event.target === DOM_BY_ID['reset-dialog']) DOM_BY_ID['reset-dialog'].close();
  });

  DOM_BY_ID['detail-prev'].addEventListener('click', () => GUIDE_PANE.stepTrophy(-1));
  DOM_BY_ID['detail-next'].addEventListener('click', () => GUIDE_PANE.stepTrophy(1));
  DOM_BY_ID['detail-reveal'].addEventListener('click', () => {
    const id = GUIDE_PANE.currentId();
    if (id === undefined) return;
    GUIDE_PANE.revealed.add(Number(id));
    GUIDE_PANE.render();
  });
  DOM_BY_ID['detail-close'].addEventListener('click', () => {
    GUIDE_PANE.revealed.clear();
    GUIDE_PANE.render();
  });
  DOM_BY_ID['detail-earned'].addEventListener('change', (event) => {
    const id = GUIDE_PANE.currentId();
    if (id !== undefined) toggleTrophyEarned(id, event.target.checked);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (DOM_BY_ID['reset-dialog'].open) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    event.preventDefault();
    selectView('checklist');
    DOM_BY_ID['search'].focus();
    DOM_BY_ID['search'].select();
  });
}

async function loadTrophyRegisters() {
  const [trophyResponse, roadmapResponse, sourceResponse] = await Promise.all([
    fetch('./data/trophies.json'),
    fetch('./data/roadmap.json'),
    fetch('./data/sources.json'),
  ]);
  if (!trophyResponse.ok) throw new Error('trophies.json returned HTTP ' + trophyResponse.status);
  if (!roadmapResponse.ok) throw new Error('roadmap.json returned HTTP ' + roadmapResponse.status);
  if (!sourceResponse.ok) throw new Error('sources.json returned HTTP ' + sourceResponse.status);
  const trophyDoc = await trophyResponse.json();
  const roadmapDoc = await roadmapResponse.json();
  const sourceDoc = await sourceResponse.json();
  if (!trophyDoc || !Array.isArray(trophyDoc.trophies) || trophyDoc.trophies.length === 0) {
    throw new Error('trophies.json has no trophy list');
  }
  TROPHY_REGISTER.trophies = trophyDoc.trophies.slice().sort((left, right) => Number(left.grade === 'platinum') - Number(right.grade === 'platinum') || Number(left.id) - Number(right.id));
  TROPHY_REGISTER.platinum = TROPHY_REGISTER.trophies.find((trophy) => trophy.grade === 'platinum') || null;
  TROPHY_REGISTER.byId = new Map(TROPHY_REGISTER.trophies.map((trophy) => [Number(trophy.id), trophy]));
  TROPHY_REGISTER.byName = new Map(TROPHY_REGISTER.trophies.map((trophy) => [trophy.name, trophy]));
  TROPHY_REGISTER.knownIds = new Set(TROPHY_REGISTER.byId.keys());
  TROPHY_REGISTER.positionById = new Map(TROPHY_REGISTER.trophies.map((trophy, index) => [Number(trophy.id), index + 1]));
  TROPHY_REGISTER.roadmap = roadmapDoc && typeof roadmapDoc === 'object' ? roadmapDoc : null;
  TROPHY_REGISTER.stages = Array.isArray(roadmapDoc && roadmapDoc.stages) ? roadmapDoc.stages : [];
  TROPHY_REGISTER.roadmapOrder = [];
  TROPHY_REGISTER.stageById = new Map();
  const seen = new Set();
  for (const stage of TROPHY_REGISTER.stages) {
    for (const name of stage.trophies || []) {
      const trophy = TROPHY_REGISTER.byName.get(name);
      if (!trophy) continue;
      const id = Number(trophy.id);
      TROPHY_REGISTER.stageById.set(id, stage);
      if (!seen.has(id)) {
        seen.add(id);
        TROPHY_REGISTER.roadmapOrder.push(trophy);
      }
    }
  }
  for (const trophy of TROPHY_REGISTER.trophies) {
    const id = Number(trophy.id);
    if (seen.has(id)) continue;
    seen.add(id);
    TROPHY_REGISTER.roadmapOrder.push(trophy);
  }
  const sourceList = Array.isArray(sourceDoc) ? sourceDoc : Array.isArray(sourceDoc && sourceDoc.sources) ? sourceDoc.sources : [];
  SOURCE_REGISTER.sources = sourceList.slice().sort((left, right) => Number(left.id) - Number(right.id));
  SOURCE_REGISTER.byId = new Map(SOURCE_REGISTER.sources.map((source) => [Number(source.id), source]));
  SOURCE_REGISTER.ids = new Set(SOURCE_REGISTER.byId.keys());
  SOURCE_REGISTER.readDate = (sourceDoc && typeof sourceDoc.read_date === 'string' ? sourceDoc.read_date : '') || (SOURCE_REGISTER.sources[0] && SOURCE_REGISTER.sources[0].read) || '';
}

function firstTrophyToOpen() {
  const unearned = TROPHY_REGISTER.roadmapOrder.filter((trophy) => !isTrophyEarned(trophy));
  return unearned.find((trophy) => trophy.missable === true) || unearned[0] || TROPHY_REGISTER.platinum || TROPHY_REGISTER.trophies[0] || null;
}

async function bootDashboard() {
  try {
    await loadTrophyRegisters();
  } catch (error) {
    DOM_BY_ID['boot'].hidden = true;
    DOM_BY_ID['boot-error'].hidden = false;
    DOM_BY_ID['boot-error-text'].textContent = 'Could not load the guide data: ' + (error && error.message ? error.message : 'unknown error') + '.';
    return;
  }
  loadSavedProgress();
  wireDashboardEvents();
  syncFilterControls();
  paintProgressCard();
  paintGradeCounters();
  paintChecklist();
  renderRoadmapStages();
  paintAuditRibbon();
  renderSourceRegister();
  const first = firstTrophyToOpen();
  if (first) GUIDE_PANE.openTrophy(first.id);
  renderNextUpQueue();
  selectView(TRACKER_STATE.view);
  DOM_BY_ID['boot'].hidden = true;
}

bootDashboard();
