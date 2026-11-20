// GTA VI trophy dashboard: offline checklist, audit ribbon, cited guide, next-up queue and saved progress.
// One ES module, no imports. Data comes from ./data/*.json; progress lives in localStorage.

const PROGRESS_KEY = 'gta6-trophy-progress-v1';
const PREFS_KEY = 'gta6-trophy-guide-prefs-v1';
const GRADE_ORDER = ['platinum', 'gold', 'silver', 'bronze'];
const KIND_NAMES = { story: 'Story', side: 'Side', collectible: 'Collectible', challenge: 'Challenge', online: 'Online', misc: 'Misc' };
const VIEW_NAMES = ['checklist', 'roadmap', 'sources'];
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

function formatReadDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return String(value || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function foldText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

const gradeBadge = (grade) => make('span', 'badge badge--' + grade, grade);
const missableBadge = () => labelledBadge('badge badge--missable', 'tpl-icon-warning', 'Missable');
const earnedBadge = () => labelledBadge('badge badge--earned', 'tpl-icon-check', 'Earned');

const guide = {
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
  sources: [],
  sourceById: new Map(),
  sourceIds: new Set(),
  readDate: '',
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

const earnedHas = (trophy) => session.earned.has(Number(trophy.id));
const concealed = (trophy) => session.spoiler && trophy.kind === 'story' && !earnedHas(trophy);
const kindName = (kind) => KIND_NAMES[kind] || kind;
const sortedEarned = () => [...session.earned].sort((left, right) => left - right);
const trophyPosition = (trophy) => guide.positionById.get(Number(trophy.id)) || guide.trophies.indexOf(trophy) + 1;
const slotLabel = (trophy) => '#' + String(trophyPosition(trophy)).padStart(2, '0');
const stageFor = (trophy) => guide.stageById.get(Number(trophy.id)) || { title: 'Roadmap', trophies: [] };

function sourceFor(value) {
  const id = Number(value);
  return Number.isInteger(id) ? guide.sourceById.get(id) || null : null;
}function gateShut() {
  return guide.trophies.some((trophy) => trophy.grade !== 'platinum' && !session.earned.has(Number(trophy.id)));
}

function gateHint() {
  return gateShut()
    ? 'Earn the other ' + (guide.trophies.length - 1) + ' trophies first'
    : 'Earned automatically: all ' + (guide.trophies.length - 1) + ' other trophies are done';
}

function enforcePlatinumGate() {
  if (!guide.platinum) return;
  if (gateShut()) session.earned.delete(Number(guide.platinum.id));
  else session.earned.add(Number(guide.platinum.id));
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
}function trophySourceItem(value) {
  const id = Number(value);
  const source = guide.sourceById.get(id) || null;
  const item = make('li', 'trophy-source');
  const top = make('div', 'trophy-source-top');
  top.append(make('span', 'chip chip--id', '[' + id + ']'));
  if (!source) {
    top.append(make('strong', '', 'Source ' + id));
    item.append(top);
    return item;
  }
  const sourceTitle = make('strong', '', source.title);
  sourceTitle.title = source.title;
  top.append(sourceTitle);
  const link = make('a', '', source.url);
  link.href = source.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  item.append(top, link, make('span', 'source-meta', source.kind + ' · read ' + formatReadDate(source.read)));
  return item;
}

function markSelectedRow() {
  const id = detail.currentId();
  for (const row of document.querySelectorAll('#trophy-list li.trophy')) {
    row.classList.toggle('is-selected', Number(row.dataset.id) === id);
  }
}

const detail = {
  order: [],
  cursor: 0,
  revealed: new Set(),
  currentId() {
    return this.order[this.cursor];
  },
  openAt(id, options = {}) {
    const visible = visibleTrophies();
    const pool = visible.some((trophy) => Number(trophy.id) === Number(id)) ? visible : guide.trophies;
    this.order = pool.map((trophy) => Number(trophy.id));
    this.cursor = Math.max(0, this.order.indexOf(Number(id)));
    this.revealed.clear();
    this.paint();
    if (!options.keepScroll) {
      const scroller = dom['detail-scroll'];
      if (scroller) scroller.scrollTop = 0;
    }
    markSelectedRow();
    if (options.revealPane && window.matchMedia('(max-width: 999px)').matches) {
      const pane = dom['detail-dialog'];
      if (pane && pane.scrollIntoView) pane.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  },
  step(offset) {
    const next = this.cursor + offset;
    if (next < 0 || next >= this.order.length) return;
    this.cursor = next;
    this.revealed.clear();
    this.paint();
    const scroller = dom['detail-scroll'];
    if (scroller) scroller.scrollTop = 0;
    markSelectedRow();
  },
  paint() {
    const trophy = guide.byId.get(this.currentId());
    if (!trophy) return;
    const masked = concealed(trophy) && !this.revealed.has(Number(trophy.id));
    dom['detail-title'].textContent = masked ? MASK_NAME : trophy.name;
    dom['detail-desc'].textContent = masked ? MASK_DESC : trophy.description;
    dom['detail-position'].textContent = trophyPosition(trophy) + ' of ' + guide.trophies.length;
    const badges = dom['detail-badges'];
    badges.replaceChildren(
      gradeBadge(trophy.grade),
      make('span', 'chip chip--kind', kindName(trophy.kind)),
      make('span', 'chip chip--id', slotLabel(trophy))
    );
    if (trophy.missable) badges.append(missableBadge());
    if (earnedHas(trophy)) badges.append(earnedBadge());
    const revealedNow = !masked && this.revealed.has(Number(trophy.id));
    dom['detail-close'].hidden = !revealedNow;
    dom['detail-locked'].hidden = !masked;
    dom['detail-content'].hidden = masked;
    dom['detail-guide'].textContent = masked ? '' : trophy.guide;
    const steps = masked ? [] : (trophy.steps || []);
    const tips = masked ? [] : (trophy.tips || []);
    const sources = masked ? [] : (Array.isArray(trophy.sources) ? trophy.sources : []);
    const stepsList = dom['trophy-steps'];
    stepsList.replaceChildren();
    for (const step of steps) {
      const item = make('li');
      if (step && typeof step === 'object') {
        item.append(make('span', 'step-text', step.text), document.createTextNode(' '));
        const id = Number(step.src);
        const source = sourceFor(id);
        const sup = make('sup', 'step-src', '[' + (Number.isFinite(id) ? id : step.src) + ']');
        sup.title = source ? 'Source ' + id + ': ' + source.title : 'Source ' + step.src;
        sup.setAttribute('aria-label', sup.title);
        item.append(sup);
      } else {
        item.textContent = String(step);
      }
      stepsList.append(item);
    }
    dom['detail-steps-section'].hidden = steps.length === 0;
    const tipsList = dom['detail-tips'];
    tipsList.replaceChildren();
    for (const tip of tips) tipsList.append(make('li', '', tip));
    const tipsSection = tipsList.closest('.detail-section');
    if (tipsSection) tipsSection.hidden = tips.length === 0;
    const sourcesList = dom['trophy-sources'];
    sourcesList.replaceChildren();
    if (masked) {
      sourcesList.append(make('li', 'trophy-source muted', 'Source titles are concealed while spoiler mode is on.'));
    } else {
      for (const source of sources) sourcesList.append(trophySourceItem(source));
    }
    dom['source-count-tag'].textContent = masked ? 'hidden' : String(sources.length);
    dom['detail-sources-section'].hidden = !masked && sources.length === 0;
    dom['trophy-sources-note'].textContent = masked
      ? 'Reveal or earn this trophy to restore its source titles.'
      : 'Each step ends with the register number of the page it came from.';
    const tick = dom['detail-earned'];
    tick.checked = earnedHas(trophy);
    tick.disabled = trophy.grade === 'platinum';
    tick.title = trophy.grade === 'platinum' ? gateHint() : '';
    dom['detail-prev'].disabled = this.cursor <= 0;
    dom['detail-next'].disabled = this.cursor >= this.order.length - 1;
    markSelectedRow();
  },
};function checkGroup(stage, rows) {
  const all = (stage.trophies || []).map((name) => guide.byName.get(name)).filter(Boolean);
  const done = all.filter(earnedHas).length;
  const section = make('section', 'check-group');
  const head = make('div', 'check-group-head');
  head.append(make('h3', 'check-group-title', stage.title), make('span', 'check-group-count', done + '/' + all.length));
  const list = make('ul', 'check-rows');
  for (const trophy of rows) list.append(checklistRow(trophy));
  section.append(head, list);
  return section;
}

function checklistRow(trophy) {
  const masked = concealed(trophy);
  const shownName = masked ? MASK_NAME : trophy.name;
  const row = make('li', 'trophy');
  row.dataset.id = String(trophy.id);
  row.dataset.grade = trophy.grade;
  row.dataset.earned = String(earnedHas(trophy));
  row.dataset.missable = String(trophy.missable === true);
  if (masked) row.dataset.locked = 'true';

  const tickWrap = make('label', 'check-wrap');
  const tick = make('input', 'earn');
  tick.type = 'checkbox';
  tick.checked = earnedHas(trophy);
  tick.setAttribute('aria-label', 'Mark "' + shownName + '" as earned');
  if (trophy.grade === 'platinum') {
    tick.disabled = gateShut();
    tick.title = gateHint();
  }
  tick.addEventListener('change', () => markTrophy(trophy.id, tick.checked));
  const tickArt = make('span', 'check-box');
  tickArt.append(fromTemplate('tpl-icon-check'));
  tickWrap.append(tick, tickArt);

  const body = make('button', 'trophy-main');
  body.type = 'button';
  body.setAttribute('aria-haspopup', 'false');
  body.setAttribute('aria-label', 'Open guide for ' + shownName);
  const headline = make('span', 'trophy-top');
  headline.append(gradeBadge(trophy.grade), make('span', 'trophy-name', shownName));
  if (trophy.missable) {
    const dot = make('span', 'row-missable');
    dot.title = 'Missable window';
    headline.append(dot);
  }
  const blurb = make('span', 'trophy-desc', masked ? MASK_DESC : trophy.description);
  const meta = make('span', 'trophy-meta');
  const idChip = make('span', 'chip chip--id sr-only', slotLabel(trophy));
  const kindChip = make('span', 'chip chip--kind sr-only', kindName(trophy.kind));
  const sourceCount = Array.isArray(trophy.sources) ? trophy.sources.length : 0;
  const srcChip = make('span', 'chip chip--src', sourceCount + ' src');
  srcChip.title = sourceCount + (sourceCount === 1 ? ' source' : ' sources') + ' cited';
  meta.append(idChip, kindChip, srcChip);
  body.append(headline, blurb, meta);
  row.append(tickWrap, body);
  row.addEventListener('click', (event) => {
    if (event.target.closest('.check-wrap')) return;
    detail.openAt(trophy.id, { revealPane: true });
  });
  return row;
}

function paintChecklist() {
  const visible = visibleTrophies();
  const visibleSet = new Set(visible.map((trophy) => Number(trophy.id)));
  const scroller = dom['list-scroll'];
  const top = scroller ? scroller.scrollTop : 0;
  const fragment = document.createDocumentFragment();
  const grouped = new Set();
  for (const stage of guide.stages) {
    const rows = (stage.trophies || [])
      .map((name) => guide.byName.get(name))
      .filter((trophy) => trophy && visibleSet.has(Number(trophy.id)));
    if (!rows.length) continue;
    for (const trophy of rows) grouped.add(Number(trophy.id));
    fragment.append(checkGroup(stage, rows));
  }
  const leftovers = visible.filter((trophy) => !grouped.has(Number(trophy.id)));
  if (leftovers.length) {
    fragment.append(checkGroup({ title: 'Other trophies', trophies: leftovers.map((trophy) => trophy.name) }, leftovers));
  }
  dom['trophy-list'].replaceChildren(fragment);
  if (scroller) scroller.scrollTop = top;
  const earnedHere = visible.filter(earnedHas).length;
  dom['visible-count'].textContent = 'Showing ' + visible.length + ' of ' + guide.trophies.length + ' · ' + earnedHere + ' earned here';
  const notes = activeFilterNotes();
  dom['clear-filters'].hidden = notes.length === 0;
  dom['empty-state'].hidden = visible.length !== 0;
  if (!visible.length) {
    dom['empty-text'].textContent = notes.length
      ? 'No trophies match ' + notes.join(', ') + '. Try a shorter search or clear the filters.'
      : 'No trophies match these filters.';
  }
  markSelectedRow();
}

function markTrophy(id, earned) {
  const trophy = guide.byId.get(Number(id));
  if (!trophy) return;
  if (trophy.grade === 'platinum') {
    paintChecklist();
    detail.paint();
    return;
  }
  if (earned) session.earned.add(Number(id));
  else session.earned.delete(Number(id));
  enforcePlatinumGate();
  persist();
  paintSummary();
  paintGradeChips();
  paintChecklist();
  paintRoadmap();
  paintNextUp();
  detail.paint();
  if (earned && session.earned.size === guide.trophies.length) toast('Platinum earned. Leonida legend!');
}function paintNextUp() {
  const list = dom['next-up-list'];
  if (!list) return;
  const unearned = guide.roadmapOrder.filter((trophy) => !earnedHas(trophy)).slice(0, 5);
  const tag = dom['next-up-section'].querySelector('.side-tag');
  if (tag) tag.textContent = unearned.length + ' unearned';
  list.replaceChildren();
  if (!unearned.length) {
    list.append(make('li', 'side-note', 'All trophies earned. The platinum is in the checklist.'));
    return;
  }
  unearned.forEach((trophy, index) => {
    const masked = concealed(trophy);
    const item = make('li');
    const button = make('button', 'next-item');
    button.type = 'button';
    button.dataset.id = String(trophy.id);
    button.setAttribute('aria-label', 'Open ' + (masked ? MASK_NAME : trophy.name));
    const rank = make('span', 'next-rank', String(index + 1));
    const body = make('span', 'next-body');
    body.append(
      make('strong', 'next-name', masked ? MASK_NAME : trophy.name),
      make('span', 'next-stage', stageFor(trophy).title)
    );
    button.append(rank, body, make('span', 'next-grade', trophy.grade));
    button.addEventListener('click', () => detail.openAt(trophy.id, { revealPane: true }));
    item.append(button);
    list.append(item);
  });
}

function roadmapChip(trophy) {
  const masked = concealed(trophy);
  const chip = make('button', 'tchip');
  chip.type = 'button';
  chip.dataset.grade = trophy.grade;
  chip.dataset.earned = String(earnedHas(trophy));
  chip.dataset.missable = String(trophy.missable === true);
  chip.dataset.hidden = String(masked);
  chip.setAttribute('aria-label', 'Open guide for ' + (masked ? MASK_NAME : trophy.name) + (earnedHas(trophy) ? ' (earned)' : ''));
  chip.append(
    make('span', 'dot'),
    fromTemplate('tpl-icon-check', 'check'),
    fromTemplate('tpl-icon-lock', 'chip-lock'),
    make('span', '', masked ? MASK_CHIP : trophy.name)
  );
  chip.addEventListener('click', () => {
    setView('checklist');
    detail.openAt(trophy.id, { revealPane: true });
  });
  return chip;
}

function summaryPill(value, label) {
  const pill = make('span', 'summary-pill');
  pill.append(make('strong', '', String(value)), document.createTextNode(' ' + label));
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
  if (!root) return;
  root.replaceChildren();
  const plan = guide.roadmap;
  if (!plan) return;
  const head = make('div', 'roadmap-head');
  const intro = make('div');
  intro.append(
    make('h2', 'roadmap-title', 'The road to the platinum'),
    make('p', 'roadmap-sub', 'Work top to bottom through ' + guide.stages.length + ' stages, from the first mission to "' + (plan.platinum || 'the platinum') + '". Ticks here and in the checklist share one save.')
  );
  const summary = make('div', 'roadmap-summary');
  summary.append(
    summaryPill(guide.trophies.length, 'trophies'),
    summaryPill(session.earned.size, 'earned'),
    summaryPill((plan.missables || []).length, 'missables'),
    summaryPill(guide.stages.length, 'stages')
  );
  head.append(intro, summary);
  root.append(head);
  const stages = make('ol', 'stages');
  guide.stages.forEach((stage, index) => stages.append(stageCard(stage, index + 1)));
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
}function paintSources() {
  const list = dom['sources-list'];
  if (!list) return;
  list.replaceChildren();
  const total = guide.trophies.length;
  for (const source of guide.sources) {
    const cited = guide.trophies.filter((trophy) => Array.isArray(trophy.sources) && trophy.sources.map(Number).includes(Number(source.id))).length;
    const row = make('li', 'source-row');
    const top = make('div', 'source-row-top');
    top.append(make('span', 'chip chip--id', '[' + source.id + ']'), make('strong', '', source.title));
    const link = make('a', '', source.url);
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const meta = make('div', 'source-meta', source.kind + ' · read ' + formatReadDate(source.read) + ' · cited by ' + cited + '/' + total + ' guides');
    row.append(top, link, meta);
    list.append(row);
  }
  const summary = dom['sources-summary'];
  if (summary) {
    summary.replaceChildren(
      summaryPill(guide.sources.length, 'sources'),
      summaryPill(total, 'trophies'),
      summaryPill(guide.trophies.reduce((sum, trophy) => sum + (trophy.steps || []).length, 0), 'steps'),
      summaryPill(guide.trophies.filter((trophy) => Array.isArray(trophy.sources) && trophy.sources.length > 0).length, 'guides with sources')
    );
  }
}

function paintAudit() {
  const total = guide.trophies.length;
  const official = guide.trophies.filter((trophy) => trophy.name && trophy.description && trophy.grade).length;
  const counts = Object.fromEntries(GRADE_ORDER.map((grade) => [grade, guide.trophies.filter((trophy) => trophy.grade === grade).length]));
  const hidden = guide.trophies.filter((trophy) => trophy.hidden === true).length;
  let steps = 0;
  let cited = 0;
  for (const trophy of guide.trophies) {
    for (const step of trophy.steps || []) {
      steps += 1;
      if (step && guide.sourceIds.has(Number(step.src))) cited += 1;
    }
  }
  const guidesCited = guide.trophies.filter((trophy) => {
    const sources = Array.isArray(trophy.sources) ? trophy.sources : [];
    return sources.length > 0 && sources.every((id) => guide.sourceIds.has(Number(id))) && typeof trophy.guide === 'string' && trophy.guide.trim() !== '';
  }).length;
  const possibleMissables = guide.roadmap && Array.isArray(guide.roadmap.missables) ? guide.roadmap.missables.length : 0;
  const missableFlags = guide.trophies.filter((trophy) => trophy.missable === true).length;
  const facts = {
    'audit-official': official + '/' + total + ' official fields',
    'audit-grades': counts.platinum + 'P · ' + counts.gold + 'G · ' + counts.silver + 'S · ' + counts.bronze + 'B · ' + hidden + ' PSN-hidden',
    'audit-steps': cited + '/' + steps + ' steps cited',
    'audit-guides': guidesCited + '/' + total + ' guides sourced',
    'audit-sources': guide.sources.length + ' sources · read ' + formatReadDate(guide.readDate),
    'audit-missables': possibleMissables + ' possible missables',
    'audit-flags': missableFlags + ' missable flags',
  };
  const titles = {
    'audit-official': 'Trophies with an official name, description and grade.',
    'audit-grades': 'Platinum, gold, silver and bronze counts, plus PSN-hidden flags.',
    'audit-steps': 'Steps whose src names an id in the source register.',
    'audit-guides': 'Trophies with a non-empty guide and at least one valid cited source.',
    'audit-sources': 'Rows in the source register and the date it was read.',
    'audit-missables': 'Trophies in the roadmap missable list.',
    'audit-flags': 'Trophies flagged missable in the trophy list.',
  };
  for (const [id, text] of Object.entries(facts)) {
    if (!dom[id]) continue;
    dom[id].textContent = text;
    dom[id].title = titles[id] || '';
  }
  if (dom['brand-sub']) dom['brand-sub'].textContent = total + ' trophies \u00b7 ' + cited + ' cited steps \u00b7 ' + missableFlags + ' missables';
  dom['audit-strip'].dataset.ready = 'true';
}let searchTimer = 0;
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
  paintNextUp();
  detail.paint();
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
    detail.revealed.clear();
    persist();
    syncFilterControls();
    paintSummary();
    paintGradeChips();
    paintChecklist();
    paintRoadmap();
    paintNextUp();
    detail.paint();
    setView(parsed.view);
    toast('Imported ' + session.earned.size + ' earned trophies');
  } catch (error) {
    toast('Import failed: ' + (error && error.message ? error.message : 'invalid file'));
  }
}

function resetProgress() {
  session.earned = new Set();
  detail.revealed.clear();
  persist();
  dom['reset-dialog'].close();
  paintSummary();
  paintGradeChips();
  paintChecklist();
  paintRoadmap();
  paintNextUp();
  detail.paint();
  toast('Progress reset');
}function wireEvents() {
  for (const name of VIEW_NAMES) {
    const tab = dom['tab-' + name];
    if (tab) tab.addEventListener('click', () => setView(name));
  }
  dom['tabs'].addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = VIEW_NAMES.indexOf(session.view);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = VIEW_NAMES[(index + direction + VIEW_NAMES.length) % VIEW_NAMES.length];
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

  dom['detail-prev'].addEventListener('click', () => detail.step(-1));
  dom['detail-next'].addEventListener('click', () => detail.step(1));
  dom['detail-reveal'].addEventListener('click', () => {
    const id = detail.currentId();
    if (id === undefined) return;
    detail.revealed.add(Number(id));
    detail.paint();
  });
  dom['detail-close'].addEventListener('click', () => {
    detail.revealed.clear();
    detail.paint();
  });
  dom['detail-earned'].addEventListener('change', (event) => {
    const id = detail.currentId();
    if (id !== undefined) markTrophy(id, event.target.checked);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (dom['reset-dialog'].open) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    event.preventDefault();
    setView('checklist');
    dom['search'].focus();
    dom['search'].select();
  });
}async function loadGuideData() {
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
  guide.trophies = trophyDoc.trophies.slice().sort((left, right) => Number(left.grade === 'platinum') - Number(right.grade === 'platinum') || Number(left.id) - Number(right.id));
  guide.platinum = guide.trophies.find((trophy) => trophy.grade === 'platinum') || null;
  guide.byId = new Map(guide.trophies.map((trophy) => [Number(trophy.id), trophy]));
  guide.byName = new Map(guide.trophies.map((trophy) => [trophy.name, trophy]));
  guide.knownIds = new Set(guide.byId.keys());
  guide.positionById = new Map(guide.trophies.map((trophy, index) => [Number(trophy.id), index + 1]));
  guide.roadmap = roadmapDoc && typeof roadmapDoc === 'object' ? roadmapDoc : null;
  guide.stages = Array.isArray(roadmapDoc && roadmapDoc.stages) ? roadmapDoc.stages : [];
  guide.roadmapOrder = [];
  guide.stageById = new Map();
  const seen = new Set();
  for (const stage of guide.stages) {
    for (const name of stage.trophies || []) {
      const trophy = guide.byName.get(name);
      if (!trophy) continue;
      const id = Number(trophy.id);
      guide.stageById.set(id, stage);
      if (!seen.has(id)) {
        seen.add(id);
        guide.roadmapOrder.push(trophy);
      }
    }
  }
  for (const trophy of guide.trophies) {
    const id = Number(trophy.id);
    if (seen.has(id)) continue;
    seen.add(id);
    guide.roadmapOrder.push(trophy);
  }
  const sourceList = Array.isArray(sourceDoc) ? sourceDoc : Array.isArray(sourceDoc && sourceDoc.sources) ? sourceDoc.sources : [];
  guide.sources = sourceList.slice().sort((left, right) => Number(left.id) - Number(right.id));
  guide.sourceById = new Map(guide.sources.map((source) => [Number(source.id), source]));
  guide.sourceIds = new Set(guide.sourceById.keys());
  guide.readDate = (sourceDoc && typeof sourceDoc.read_date === 'string' ? sourceDoc.read_date : '') || (guide.sources[0] && guide.sources[0].read) || '';
}

function initialTrophy() {
  const unearned = guide.roadmapOrder.filter((trophy) => !earnedHas(trophy));
  return unearned.find((trophy) => trophy.missable === true) || unearned[0] || guide.platinum || guide.trophies[0] || null;
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
  paintAudit();
  paintSources();
  const first = initialTrophy();
  if (first) detail.openAt(first.id);
  paintNextUp();
  setView(session.view);
  dom['boot'].hidden = true;
}

boot();