import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://localhost:8080/';
const CHROME = 'C:/Users/Administrator/AppData/Local/BrowserClaw/Application/chrome.exe';
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
const profile = mkdtempSync(join(tmpdir(), 'gta6-qa-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  APP,
], { stdio: 'ignore' });

let cdp;
let exitCode = 0;
try {
  const target = await cdpTarget();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: APP });
  await ready(cdp);
  await evaluate(cdp, 'localStorage.clear()');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(300);
  await ready(cdp);

  const before = await evaluate(cdp, "(() => [...document.querySelectorAll('#trophy-list .trophy-name')].map((n) => n.textContent))()");

  const ticked = await evaluate(cdp, `(() => {
    const picked = [];
    for (const row of document.querySelectorAll('li.trophy')) {
      if (picked.length === 3) break;
      const box = row.querySelector('input.earn');
      if (!box.checked) { box.click(); picked.push(row.querySelector('.trophy-name').textContent); }
    }
    return picked;
  })()`);

  await evaluate(cdp, "document.getElementById('spoiler-toggle').click()");

  const lockedCount = await evaluate(cdp, `document.querySelectorAll('li.trophy[data-locked="true"]').length`);
  const firstLockedText = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    return row ? row.innerText : null;
  })()`);

  const checkboxTest = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    const idText = row.querySelector('.chip--id').textContent;
    row.querySelector('input.earn').click();
    const after = [...document.querySelectorAll('li.trophy')].find((r) => r.querySelector('.chip--id').textContent === idText);
    return {
      id: idText,
      boxChecked: after.querySelector('input.earn').checked,
      locked: after.dataset.locked || null,
      name: after.querySelector('.trophy-name').textContent,
    };
  })()`);

  const earnedStory = await evaluate(cdp, `(() => [...document.querySelectorAll('li.trophy')]
    .filter((row) => row.querySelector('input.earn').checked && row.querySelector('.chip--kind').textContent === 'Story')
    .map((row) => ({
      id: row.querySelector('.chip--id').textContent,
      name: row.querySelector('.trophy-name').textContent,
      locked: row.dataset.locked || null,
    })))()`);

  const dialogTest = await evaluate(cdp, `(() => {
    const row = document.querySelector('li.trophy[data-locked="true"]');
    const id = row.querySelector('.chip--id').textContent;
    row.querySelector('.trophy-main').click();
    return {
      id,
      open: document.getElementById('detail-dialog').open,
      title: document.getElementById('detail-title').textContent,
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
      contentHidden: getComputedStyle(document.getElementById('detail-content')).display === 'none',
      hasReveal: !!document.getElementById('detail-reveal'),
    };
  })()`);

  const revealTest = await evaluate(cdp, `(() => {
    document.getElementById('detail-reveal').click();
    return {
      spoilerToggleStillOn: document.getElementById('spoiler-toggle').checked,
      lockedHidden: getComputedStyle(document.getElementById('detail-locked')).display === 'none',
      contentShown: getComputedStyle(document.getElementById('detail-content')).display !== 'none',
      title: document.getElementById('detail-title').textContent,
    };
  })()`);

  await evaluate(cdp, `document.getElementById('detail-dialog').close()`);
  await sleep(150);

  const reopenTest = await evaluate(cdp, `(() => {
    const idText = ${JSON.stringify(dialogTest.id)};
    const row = [...document.querySelectorAll('li.trophy')].find((r) => r.querySelector('.chip--id').textContent === idText);
    row.querySelector('.trophy-main').click();
    const result = {
      id: idText,
      title: document.getElementById('detail-title').textContent,
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
    };
    document.getElementById('detail-dialog').close();
    return result;
  })()`);
  await sleep(150);
  const roadmapTest = await evaluate(cdp, `(() => {
    document.getElementById('tab-roadmap').click();
    const chips = [...document.querySelectorAll('.tchip[data-hidden="true"]')];
    const chip = chips[0];
    const label = chip ? chip.textContent.trim() : null;
    if (chip) chip.click();
    const result = {
      hiddenChips: chips.length,
      label,
      dialogOpened: document.getElementById('detail-dialog').open,
      lockedShown: getComputedStyle(document.getElementById('detail-locked')).display !== 'none',
    };
    document.getElementById('detail-dialog').close();
    document.getElementById('tab-checklist').click();
    return result;
  })()`);
  await sleep(100);

  const off = await evaluate(cdp, `(() => {
    document.getElementById('spoiler-toggle').click();
    return {
      lockedRows: document.querySelectorAll('li.trophy[data-locked="true"]').length,
      names: [...document.querySelectorAll('#trophy-list .trophy-name')].map((n) => n.textContent),
    };
  })()`);

  const namesMatchBefore = before.length === off.names.length && before.every((name, index) => name === off.names[index]);
  const report = {
    ticked,
    spoilerOn: {
      lockedRows: lockedCount,
      firstConcealedInnerText: firstLockedText,
      checkboxOnConcealedRow: checkboxTest,
      earnedStoryTrophies: earnedStory,
    },
    detailDialog: { initial: dialogTest, oneViewReveal: revealTest, afterCloseAndReopen: reopenTest },
    roadmapChip: roadmapTest,
    spoilerOff: {
      lockedRows: off.lockedRows,
      hiddenPlaceholders: off.names.filter((name) => name === 'Hidden story trophy').length,
      realNamesMatchBefore: namesMatchBefore,
      sample: off.names.slice(0, 4),
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (!(lockedCount > 0)) failures.push('no li.trophy[data-locked=true] rows while spoiler mode is on');
  if (!firstLockedText || !firstLockedText.includes('Hidden story trophy')) failures.push('concealed row has no placeholder name');
  if (!firstLockedText || !firstLockedText.includes('Turn spoiler mode off to read this.')) failures.push('concealed row has no spoiler description');
  if (earnedStory.some((row) => row.locked !== null)) failures.push('an earned story trophy is still concealed');
  if (!checkboxTest.boxChecked || checkboxTest.locked !== null || checkboxTest.name === 'Hidden story trophy') failures.push('checkbox on a concealed row did not earn and reveal it');
  if (!dialogTest.open || !dialogTest.lockedShown || !dialogTest.contentHidden || !dialogTest.hasReveal) failures.push('detail dialog lock state is wrong');
  if (!revealTest.spoilerToggleStillOn || !revealTest.lockedHidden || !revealTest.contentShown) failures.push('one-view reveal is wrong');
  if (!reopenTest.lockedShown) failures.push('reveal persisted after closing and reopening the dialog');
  if (roadmapTest.label !== 'Hidden' || !roadmapTest.dialogOpened || !roadmapTest.lockedShown) failures.push('roadmap chip concealment is wrong');
  if (off.lockedRows !== 0 || !namesMatchBefore) failures.push('turning spoiler mode off did not restore the real names');
  if (failures.length) {
    console.error('FAILURES:', failures);
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