import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://localhost:8080/';
const CHROME = 'C:/Users/Administrator/AppData/Local/BrowserClaw/Application/chrome.exe';
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trophyDoc = JSON.parse(readFileSync('app/data/trophies.json', 'utf8'));
const trophies = trophyDoc.trophies;
const roadmap = JSON.parse(readFileSync('app/data/roadmap.json', 'utf8'));
const sourceDoc = JSON.parse(readFileSync('app/data/sources.json', 'utf8'));
const sources = sourceDoc.sources.slice().sort((left, right) => left.id - right.id);
const sorted = trophies.slice().sort((left, right) => Number(left.grade === 'platinum') - Number(right.grade === 'platinum') || left.id - right.id);
const total = trophies.length;
const gradeCounts = Object.fromEntries(['platinum', 'gold', 'silver', 'bronze'].map((grade) => [grade, trophies.filter((trophy) => trophy.grade === grade).length]));
const hidden = trophies.filter((trophy) => trophy.hidden === true).length;
const allSteps = trophies.flatMap((trophy) => trophy.steps || []);
const citedSteps = allSteps.filter((step) => step && sources.some((source) => source.id === Number(step.src))).length;
const guidesCited = trophies.filter((trophy) => Array.isArray(trophy.sources) && trophy.sources.length > 0 && trophy.sources.every((id) => sources.some((source) => source.id === Number(id))) && typeof trophy.guide === 'string' && trophy.guide.trim() !== '').length;
const missableFlags = trophies.filter((trophy) => trophy.missable === true).length;
const fairGame = trophies.find((trophy) => trophy.name === 'Fair Game');
const fairGamePosition = sorted.findIndex((trophy) => trophy.id === fairGame.id) + 1;
const fairGameSources = fairGame.sources.map((id) => sources.find((source) => source.id === Number(id)));
const readDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(sourceDoc.read_date + 'T00:00:00Z'));
const storyNames = sorted.filter((trophy) => trophy.kind === 'story').map((trophy) => trophy.name);
const expectedAudit = {
  'audit-official': total + '/' + total + ' official fields',
  'audit-grades': gradeCounts.platinum + 'P \u00b7 ' + gradeCounts.gold + 'G \u00b7 ' + gradeCounts.silver + 'S \u00b7 ' + gradeCounts.bronze + 'B \u00b7 ' + hidden + ' PSN-hidden',
  'audit-steps': citedSteps + '/' + allSteps.length + ' steps cited',
  'audit-guides': guidesCited + '/' + total + ' guides sourced',
  'audit-sources': sources.length + ' sources \u00b7 read ' + readDate,
  'audit-missables': roadmap.missables.length + ' possible missables',
  'audit-flags': missableFlags + ' missable flags',
};

async function cdpTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome CDP target not found on port ' + PORT);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      if (message.error) job.reject(new Error(message.error.message));
      else job.resolve(message.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const connect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve(new CDP(ws));
  ws.onerror = () => reject(new Error('WebSocket connection failed'));
});

async function evaluate(cdp, expression) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) {
    throw new Error((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text);
  }
  return out.result.value;
}

async function ready(cdp) {
  for (let i = 0; i < 120; i++) {
    try {
      if (await evaluate(cdp, "document.readyState === 'complete' && document.querySelectorAll('#trophy-list li.trophy').length > 0")) return;
    } catch {}
    await sleep(100);
  }
  let diag = null;
  try { diag = await evaluate(cdp, "({ href: location.href, ready: document.readyState, rows: document.querySelectorAll('#trophy-list li.trophy').length, bootHidden: document.getElementById('boot') ? document.getElementById('boot').hidden : null, bootErrorHidden: document.getElementById('boot-error') ? document.getElementById('boot-error').hidden : null, bootErrorText: document.getElementById('boot-error-text') ? document.getElementById('boot-error-text').textContent : null })"); } catch {}
  throw new Error('App did not finish booting: ' + JSON.stringify(diag));
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail || '' });
}

const profile = mkdtempSync(join(tmpdir(), 'gta6-qa-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  APP,
], { stdio: 'ignore' });let cdp;
let exitCode = 0;
try {
  const target = await cdpTarget();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: APP });
  await ready(cdp);
  await evaluate(cdp, 'localStorage.clear()');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(350);
  await ready(cdp);

  const audit = await evaluate(cdp, `(() => {
    const ids = ['audit-official', 'audit-grades', 'audit-steps', 'audit-guides', 'audit-sources', 'audit-missables', 'audit-flags'];
    return Object.fromEntries(ids.map((id) => {
      const node = document.getElementById(id);
      return [id, node ? node.textContent.trim() : null];
    }));
  })()`);
  for (const [id, expected] of Object.entries(expectedAudit)) {
    check('audit ' + id, audit[id] === expected, JSON.stringify(audit[id]) + ' expected ' + JSON.stringify(expected));
  }

  const panes = await evaluate(cdp, `(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
    };
    const auditRect = document.getElementById('audit-strip').getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      list: box('.pane-list'),
      detail: box('.pane-detail'),
      side: box('.pane-side'),
      audit: { y: auditRect.y, height: auditRect.height, bottom: auditRect.bottom },
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      display: {
        list: getComputedStyle(document.querySelector('.pane-list')).display,
        detail: getComputedStyle(document.querySelector('.pane-detail')).display,
        side: getComputedStyle(document.querySelector('.pane-side')).display,
      },
    };
  })()`);
  check('three panes side by side at 1280x800', panes.display.list === 'flex' && panes.display.detail === 'flex' && panes.display.side === 'flex' && Math.abs(panes.list.y - panes.detail.y) <= 2 && Math.abs(panes.detail.y - panes.side.y) <= 2 && panes.list.right <= panes.detail.x + 1 && panes.detail.right <= panes.side.x + 1, JSON.stringify(panes));
  check('pane widths 340 / 300 at 1280', Math.abs(panes.list.width - 340) <= 40 && Math.abs(panes.side.width - 300) <= 40 && panes.detail.width > panes.list.width && panes.detail.width > panes.side.width, 'left ' + Math.round(panes.list.width) + ', detail ' + Math.round(panes.detail.width) + ', right ' + Math.round(panes.side.width));
  check('audit ribbon sits above the panes', panes.audit.bottom <= panes.list.y + 1, 'ribbon bottom ' + Math.round(panes.audit.bottom) + ', panes top ' + Math.round(panes.list.y));
  check('audit ribbon is one row at 1280', panes.audit.height <= 46, 'height ' + Math.round(panes.audit.height));
  check('no horizontal scroll at 1280', panes.scrollWidth <= 1280 && panes.bodyScrollWidth <= 1280, 'doc ' + panes.scrollWidth + ', body ' + panes.bodyScrollWidth);  await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-id="${fairGame.id}"]');
    if (!row) throw new Error('Fair Game row not found');
    row.querySelector('.trophy-main').click();
  })()`);
  await sleep(180);

  const opened = await evaluate(cdp, `(() => {
    const steps = [...document.querySelectorAll('#trophy-steps li')];
    const markers = steps.map((li) => {
      const sup = li.querySelector('sup.step-src');
      return sup ? { text: sup.textContent.trim(), title: sup.title, label: sup.getAttribute('aria-label') } : null;
    });
    const sourceRows = [...document.querySelectorAll('#trophy-sources li')].map((li) => ({
      text: li.textContent.trim(),
      id: (li.querySelector('.chip--id') || {}).textContent || '',
      title: (li.querySelector('strong') || {}).textContent || '',
    }));
    const badges = [...document.querySelectorAll('#detail-badges .badge, #detail-badges .chip')].map((node) => node.textContent.trim());
    return {
      title: document.getElementById('detail-title').textContent.trim(),
      position: document.getElementById('detail-position').textContent.trim(),
      description: document.getElementById('detail-desc').textContent.trim(),
      guide: document.getElementById('detail-guide').textContent.trim(),
      missable: !!document.querySelector('#detail-badges .badge--missable'),
      kind: (document.querySelector('#detail-badges .chip--kind') || {}).textContent || '',
      badges,
      steps: steps.length,
      markers,
      firstStep: steps[0] ? steps[0].textContent.trim() : null,
      sourceRows,
      sourceCountTag: document.getElementById('source-count-tag').textContent.trim(),
      earnedChecked: document.getElementById('detail-earned').checked,
    };
  })()`);
  check('middle pane opens Fair Game', opened.title === 'Fair Game' && opened.position === fairGamePosition + ' of ' + total, opened.title + ' / ' + opened.position);
  check('middle pane shows missable + kind pills', opened.missable && opened.kind.trim() === 'Side', JSON.stringify(opened.badges));
  check('middle pane shows the official description and guide', opened.description === fairGame.description && opened.guide === fairGame.guide, 'description ' + opened.description.length + ' chars, guide ' + opened.guide.length + ' chars');
  check('numbered steps carry one citation marker each', opened.steps === fairGame.steps.length && opened.markers.length === opened.steps && opened.markers.every((marker) => marker && /^\[\d+\]$/.test(marker.text)), opened.markers.length + ' markers / ' + opened.steps + ' steps');
  const markerTitlesOk = opened.markers.every((marker, index) => {
    const source = sources.find((item) => item.id === Number(fairGame.steps[index].src));
    return marker && source && marker.title.includes(source.title) && marker.label === marker.title;
  });
  check('step marker titles name their sources', markerTitlesOk, opened.markers[0] ? opened.markers[0].title.slice(0, 90) : 'no marker');
  check('sources-in-this-guide lists the opened trophy register rows', opened.sourceRows.length === fairGameSources.length && opened.sourceRows.every((row, index) => row.id === '[' + fairGameSources[index].id + ']' && row.title === fairGameSources[index].title) && opened.sourceCountTag === String(fairGameSources.length), opened.sourceRows.map((row) => row.id).join(' '));
  check('middle Mark earned is wired to the same store', opened.earnedChecked === false, 'checked ' + opened.earnedChecked);

  const typography = await evaluate(cdp, `(() => {
    const size = (selector) => {
      const node = document.querySelector(selector);
      return node ? parseFloat(getComputedStyle(node).fontSize) : 0;
    };
    return { body: size('body'), trophyName: size('li.trophy .trophy-name'), title: size('#detail-title'), step: size('#trophy-steps li'), audit: size('.audit-fact') };
  })()`);
  check('body text is at least 16px', typography.body >= 16, typography.body + 'px');
  check('trophy names are 15-17px', typography.trophyName >= 15 && typography.trophyName <= 17, typography.trophyName + 'px');
  check('opened title is at least 26px', typography.title >= 26, typography.title + 'px');
  check('step text is at least 17px', typography.step >= 17, typography.step + 'px');
  check('audit facts are at least 13px', typography.audit >= 13, typography.audit + 'px');  const before = await evaluate(cdp, "(() => [...document.querySelectorAll('#trophy-list .trophy-name')].map((node) => node.textContent))()");
  const ticked = [];
  for (let index = 0; index < 3; index++) {
    const name = await evaluate(cdp, `(() => {
      const row = [...document.querySelectorAll('li.trophy')].find((item) => !item.querySelector('input.earn').checked);
      if (!row) return null;
      const label = row.querySelector('.trophy-name').textContent;
      row.querySelector('input.earn').click();
      return label;
    })()`);
    if (name) ticked.push(name);
    await sleep(90);
  }
  await sleep(180);

  await evaluate(cdp, "document.getElementById('spoiler-toggle').click()");
  await sleep(150);
  const lockedCount = await evaluate(cdp, "document.querySelectorAll('li.trophy[data-locked=\"true\"]').length");
  const firstLockedText = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    return row ? row.innerText : null;
  })()`);
  check('spoiler mode conceals story rows', lockedCount > 0 && !!firstLockedText && firstLockedText.includes('Hidden story trophy') && firstLockedText.includes('Turn spoiler mode off to read this.'), lockedCount + ' locked rows');

  const initialLeakNames = storyNames.filter((name) => !ticked.includes(name));
  const initialLeakText = await evaluate(cdp, 'document.body.innerText');
  const initialLeaks = initialLeakNames.filter((name) => initialLeakText.includes(name));
  check('spoiler mode leaks no concealed story names', initialLeaks.length === 0, initialLeaks.join(' | '));

  const checkboxTest = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    const id = row.dataset.id;
    row.querySelector('input.earn').click();
    const after = [...document.querySelectorAll('li.trophy')].find((item) => item.dataset.id === id);
    return {
      id,
      boxChecked: after.querySelector('input.earn').checked,
      locked: after.dataset.locked || null,
      name: after.querySelector('.trophy-name').textContent,
    };
  })()`);
  check('checkbox on a concealed row earns and reveals it', checkboxTest.boxChecked && checkboxTest.locked === null && checkboxTest.name !== 'Hidden story trophy', JSON.stringify(checkboxTest));

  const earnedStory = await evaluate(cdp, `(() => [...document.querySelectorAll('li.trophy')]
    .filter((row) => row.querySelector('input.earn').checked && row.querySelector('.chip--kind').textContent.trim() === 'Story')
    .map((row) => ({
      id: row.dataset.id,
      name: row.querySelector('.trophy-name').textContent,
      locked: row.dataset.locked || null,
    })))()`);
  check('earned story trophies are not concealed', earnedStory.every((row) => row.locked === null), earnedStory.length + ' earned story rows');  const maskedDetail = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    row.querySelector('.trophy-main').click();
    return {
      id: row.dataset.id,
      title: document.getElementById('detail-title').textContent.trim(),
      desc: document.getElementById('detail-desc').textContent.trim(),
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
      contentHidden: getComputedStyle(document.getElementById('detail-content')).display === 'none',
      guide: document.getElementById('detail-guide').textContent.trim(),
      steps: document.querySelectorAll('#trophy-steps li').length,
      tips: document.querySelectorAll('#detail-tips li').length,
      sourceRows: document.querySelectorAll('#trophy-sources li').length,
      rightText: document.getElementById('trophy-sources').innerText,
      sourceCountTag: document.getElementById('source-count-tag').textContent.trim(),
      panelVisible: !document.getElementById('panel-checklist').hidden,
      position: document.getElementById('detail-position').textContent.trim(),
    };
  })()`);
  const lockedTrophy = trophies.find((trophy) => String(trophy.id) === maskedDetail.id);
  const lockedPosition = sorted.findIndex((trophy) => trophy.id === Number(maskedDetail.id)) + 1;
  check('middle pane conceals the opened story trophy', maskedDetail.panelVisible && maskedDetail.title === 'Hidden story trophy' && maskedDetail.desc === 'Turn spoiler mode off to read this.' && maskedDetail.lockedShown && maskedDetail.contentHidden, maskedDetail.title + ' / ' + maskedDetail.position);
  check('concealed middle shows no guide, steps or tips', maskedDetail.guide === '' && maskedDetail.steps === 0 && maskedDetail.tips === 0, 'guide ' + maskedDetail.guide.length + ', steps ' + maskedDetail.steps + ', tips ' + maskedDetail.tips);
  check('concealed middle hides source titles', maskedDetail.sourceRows === 1 && maskedDetail.sourceCountTag === 'hidden' && lockedTrophy.sources.every((id) => !maskedDetail.rightText.includes(sources.find((source) => source.id === Number(id)).title)), maskedDetail.rightText.slice(0, 90));
  check('opened trophy number stays in the 1-55 slot', maskedDetail.position === lockedPosition + ' of ' + total, maskedDetail.position);

  const earnedNames = earnedStory.map((row) => row.name);
  const stillConcealed = storyNames.filter((name) => !ticked.includes(name) && !earnedNames.includes(name));
  const leakText = await evaluate(cdp, 'document.body.innerText');
  const leaks = stillConcealed.filter((name) => leakText.includes(name));
  check('spoiler mode still leaks nothing after opening a locked row', leaks.length === 0, leaks.join(' | '));

  const revealTest = await evaluate(cdp, `(() => {
    document.getElementById('detail-reveal').click();
    return {
      spoilerToggleStillOn: document.getElementById('spoiler-toggle').checked,
      lockedHidden: getComputedStyle(document.getElementById('detail-locked')).display === 'none',
      contentShown: getComputedStyle(document.getElementById('detail-content')).display !== 'none',
      title: document.getElementById('detail-title').textContent.trim(),
      steps: document.querySelectorAll('#trophy-steps li').length,
      sourceRows: document.querySelectorAll('#trophy-sources li').length,
      closeShown: !document.getElementById('detail-close').hidden,
    };
  })()`);
  check('one-view reveal exposes the trophy without toggling spoiler off', revealTest.spoilerToggleStillOn && revealTest.lockedHidden && revealTest.contentShown && revealTest.title === lockedTrophy.name && revealTest.steps === lockedTrophy.steps.length && revealTest.sourceRows === lockedTrophy.sources.length, revealTest.title + ' / ' + revealTest.steps + ' steps');
  check('one-view reveal is offered a re-conceal control', revealTest.closeShown, 'close hidden ' + !revealTest.closeShown);

  const recloseTest = await evaluate(cdp, `(() => {
    document.getElementById('detail-close').click();
    return {
      title: document.getElementById('detail-title').textContent.trim(),
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
      contentHidden: getComputedStyle(document.getElementById('detail-content')).display === 'none',
      closeHidden: document.getElementById('detail-close').hidden,
    };
  })()`);
  check('re-conceal restores the spoiler mask', recloseTest.title === 'Hidden story trophy' && recloseTest.lockedShown && recloseTest.contentHidden && recloseTest.closeHidden, recloseTest.title);

  const reopenTest = await evaluate(cdp, `(() => {
    const other = document.querySelector('li.trophy[data-id="${fairGame.id}"]');
    const target = document.querySelector('li.trophy[data-id="${maskedDetail.id}"]');
    if (other) other.querySelector('.trophy-main').click();
    if (target) target.querySelector('.trophy-main').click();
    return {
      title: document.getElementById('detail-title').textContent.trim(),
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
    };
  })()`);
  check('reveal does not persist after selecting another trophy', reopenTest.title === 'Hidden story trophy' && reopenTest.lockedShown, reopenTest.title);  const roadmapTest = await evaluate(cdp, `(() => {
    document.getElementById('tab-roadmap').click();
    const chips = [...document.querySelectorAll('.tchip[data-hidden="true"]')];
    const chip = chips[0];
    const label = chip ? chip.textContent.trim() : null;
    if (chip) chip.click();
    const result = {
      hiddenChips: chips.length,
      label,
      checklistShown: !document.getElementById('panel-checklist').hidden,
      title: document.getElementById('detail-title').textContent.trim(),
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
    };
    document.getElementById('tab-checklist').click();
    return result;
  })()`);
  check('roadmap chip concealment opens the masked middle pane', roadmapTest.hiddenChips > 0 && roadmapTest.label === 'Hidden' && roadmapTest.checklistShown && roadmapTest.title === 'Hidden story trophy' && roadmapTest.lockedShown, JSON.stringify(roadmapTest));

  const off = await evaluate(cdp, `(() => {
    document.getElementById('spoiler-toggle').click();
    return {
      lockedRows: document.querySelectorAll('li.trophy[data-locked="true"]').length,
      names: [...document.querySelectorAll('#trophy-list .trophy-name')].map((node) => node.textContent),
      toggle: document.getElementById('spoiler-toggle').checked,
    };
  })()`);
  const namesMatchBefore = before.length === off.names.length && before.every((name, index) => name === off.names[index]);
  check('spoiler off restores every real name', off.toggle === false && off.lockedRows === 0 && namesMatchBefore, off.names.length + ' names');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const small = await evaluate(cdp, `(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
    };
    const list = box('.pane-list');
    const detail = box('.pane-detail');
    const side = box('.pane-side');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      list,
      detail,
      side,
      paneRight: Math.max(list.right, detail.right, side.right),
      sideBySide: list.right <= detail.x + 1 && detail.right <= side.x + 1,
    };
  })()`);
  check('no horizontal scroll at 1024x640', small.scrollWidth <= 1024 && small.bodyScrollWidth <= 1024 && small.paneRight <= 1025, 'doc ' + small.scrollWidth + ', body ' + small.bodyScrollWidth + ', pane right ' + Math.round(small.paneRight));
  check('three panes remain side by side at 1024', small.sideBySide && small.list.width > 200 && small.side.width > 200, Math.round(small.list.width) + ' / ' + Math.round(small.detail.width) + ' / ' + Math.round(small.side.width));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const stack = await evaluate(cdp, `(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
    };
    const list = box('.pane-list');
    const detail = box('.pane-detail');
    const side = box('.pane-side');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      list,
      detail,
      side,
      stacked: list.y < detail.y && detail.y < side.y,
    };
  })()`);
  check('panes stack below 1000px, list then detail then right', stack.stacked && stack.scrollWidth <= 960 && stack.bodyScrollWidth <= 960, 'y ' + Math.round(stack.list.y) + ' / ' + Math.round(stack.detail.y) + ' / ' + Math.round(stack.side.y));

  const report = {
    auditFacts: audit,
    panes1280: panes,
    openedTrophy: {
      title: opened.title,
      position: opened.position,
      firstStep: opened.firstStep,
      firstMarker: opened.markers[0],
      stepCount: opened.steps,
      sourceRows: opened.sourceRows,
    },
    spoilerOn: {
      lockedRows: lockedCount,
      initialLeaks,
      maskedTitle: maskedDetail.title,
      revealTitle: revealTest.title,
      reopenTitle: reopenTest.title,
    },
    responsive: { at1024: small, at960: stack },
    typography,
  };
  console.log(JSON.stringify(report, null, 2));

  for (const item of checks) {
    console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.detail ? ' \u2014 ' + item.detail : ''));
  }
  const failures = checks.filter((item) => !item.ok);
  if (failures.length) {
    console.error('FAILURES: ' + failures.map((item) => item.name).join(' | '));
    exitCode = 1;
  } else {
    console.log('ALL CHECKS PASSED');
  }
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (process.env.SERVER_PID) {
    try { process.kill(Number(process.env.SERVER_PID)); console.log('server process ' + process.env.SERVER_PID + ' killed'); }
    catch (error) { console.error('server kill failed:', error.message); }
  }
  process.exitCode = exitCode;
}