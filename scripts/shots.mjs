// scripts/shots.mjs: capture the four competition screenshots over CDP.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shotsDir = join(root, "screenshots");
const appUrl = "http://localhost:8080/";
const chromePath = "C:/Users/Administrator/AppData/Local/BrowserClaw/Application/chrome.exe";
const debugPort = 9333;
const WIDTH = 1024;
const HEIGHT = 640;
const JPEG_QUALITY = 82;
const MAX_BYTES = 262144;
const MAX_LONG_SIDE = 1280;
const MIN_SHORT_SIDE = 480;

const PROGRESS_KEY = "gta6-trophy-progress-v1";
const PREFS_KEY = "gta6-trophy-guide-prefs-v1";

// 31/55: main story and both missables complete, ten side trophies,
// four collectibles (PMA is still open for shot 2) and three challenges.
// One gold, four silvers, 26 bronze; the platinum stays locked.
const COVER_EARNED = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  15, 16, 18, 19, 20, 21, 22, 23, 25, 26, 27,
  29, 30, 31, 32, 35, 36, 42, 48,
];

const blankFilters = { grade: "all", kind: "all", query: "", hideCompleted: false, missablesOnly: false };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let server = null;
let chrome = null;
let cdp = null;
let sessionId = null;
let profile = null;

function curlStatus(url = appUrl) {
  try {
    return execFileSync("curl.exe", ["-s", "-o", "NUL", "-w", "%{http_code}", url], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function listeningPids(port) {
  try {
    const rows = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 5000 }).split(/\r?\n/);
    const pids = new Set();
    for (const row of rows) {
      if (!row.includes(":" + port + " ") || !/\bLISTENING\b/i.test(row)) continue;
      const pid = row.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid) && Number(pid) > 0) pids.add(Number(pid));
    }
    return [...pids];
  } catch {
    return [];
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 });
  } catch {}
  try { child.kill(); } catch {}
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    if (curlStatus() === "200") return;
    await sleep(250);
  }
  throw new Error("serve.ts did not answer 200 on " + appUrl);
}

async function waitForJson(url) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint did not answer: " + url);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = [];
  }
  async open() {
    await new Promise((done, fail) => {
      this.ws.addEventListener("open", done, { once: true });
      this.ws.addEventListener("error", fail, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.fail(new Error(message.error.message));
        else pending.done(message.result || {});
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.method !== message.method) continue;
        if (waiter.sessionId && waiter.sessionId !== message.sessionId) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.done(message.params || {});
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      this.ws.send(JSON.stringify(payload));
    });
  }
  waitEvent(method, sessionId, timeoutMs = 25000) {
    return new Promise((done, fail) => {
      const waiter = { method, sessionId, done };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at < 0) return;
        this.waiters.splice(at, 1);
        fail(new Error("timed out waiting for " + method));
      }, timeoutMs);
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function evaluate(expression) {
  const out = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (out.exceptionDetails) {
    const detail = out.exceptionDetails.exception && out.exceptionDetails.exception.description;
    throw new Error("page error: " + (detail || out.exceptionDetails.text));
  }
  return out.result ? out.result.value : undefined;
}

async function waitUntil(check, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error("timed out: " + label);
}

async function waitForRows() {
  await waitUntil(
    async () => (await evaluate(`document.querySelectorAll("#trophy-list li.trophy").length`)) === 55,
    "55 trophy rows"
  );
}

async function reloadApp() {
  const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 30000);
  await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
  await loaded;
  await sleep(700);
  await waitForRows();
}

async function seed(ids, options = {}) {
  const spoiler = options.spoiler === true;
  const tab = options.tab || "checklist";
  const progress = JSON.stringify(ids);
  const prefs = JSON.stringify({ spoiler, filters: blankFilters, tab });
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem(${JSON.stringify(PROGRESS_KEY)}, ${JSON.stringify(progress)});
    localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(prefs)});
    return true;
  })()`);
  await reloadApp();
  console.log(`seeded ${ids.length}/55${spoiler ? " with spoiler mode on" : ""}`);
}

async function readProgress() {
  return evaluate(`(() => {
    const rows = [...document.querySelectorAll("#trophy-list li.trophy")];
    const platinum = rows.find((row) => row.dataset.grade === "platinum");
    return {
      rows: rows.length,
      earned: document.getElementById("earned-count").textContent.trim(),
      total: document.getElementById("progress-total").textContent.trim(),
      percent: document.getElementById("percent").textContent.trim(),
      barWidth: document.getElementById("bar-fill").style.width,
      platinumText: document.getElementById("platinum-text").textContent.trim(),
      platinumChecked: platinum ? platinum.querySelector("input.earn").checked : null,
      groups: [...document.querySelectorAll(".check-group")].map((section) => ({
        title: section.querySelector(".check-group-title").textContent.trim(),
        count: section.querySelector(".check-group-count").textContent.trim(),
      })),
    };
  })()`);
}

function assertProgress(state, expected) {
  if (state.rows !== 55) throw new Error("expected 55 rows, got " + state.rows);
  if (Number(state.earned) !== expected) throw new Error("expected " + expected + " earned, got " + state.earned);
  if (state.total !== "/ 55") throw new Error("unexpected total label: " + state.total);
  if (!state.barWidth || state.barWidth === "0%") throw new Error("progress bar is empty");
  if (state.platinumChecked) throw new Error("platinum must stay locked");
  console.log("progress " + JSON.stringify({
    earned: state.earned,
    total: state.total,
    percent: state.percent,
    bar: state.barWidth,
    platinum: state.platinumText,
    groups: state.groups,
  }));
}

async function openTrophy(id, expectedTitle) {
  const found = await evaluate(`(() => {
    const row = document.querySelector('li.trophy[data-id="${id}"]');
    if (!row) return false;
    row.querySelector(".trophy-main").click();
    return true;
  })()`);
  if (!found) throw new Error("trophy row " + id + " not found");
  await waitUntil(async () => {
    const state = await evaluate(`(() => ({
      title: document.getElementById("detail-title").textContent.trim(),
      locked: !document.getElementById("detail-locked").hidden,
    }))()`);
    return expectedTitle ? state.title === expectedTitle : state.locked;
  }, "detail pane for " + (expectedTitle || "locked story trophy"));
  await sleep(250);
}

async function scrollChecklistToGroup(title, offset = 120) {
  const top = await evaluate(`(() => {
    const scroller = document.getElementById("list-scroll");
    const head = [...document.querySelectorAll(".check-group-title")].find((node) => node.textContent.trim() === ${JSON.stringify(title)});
    if (!scroller || !head) return false;
    const section = head.closest(".check-group");
    const dy = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + dy - ${offset});
    return Math.round(scroller.scrollTop);
  })()`);
  if (top === false) throw new Error("checklist group not found: " + title);
  await sleep(200);
  return top;
}

async function alignChecklistRow(id, gap = 0) {
  const top = await evaluate(`(() => {
    const scroller = document.getElementById("list-scroll");
    const row = document.querySelector('li.trophy[data-id="${id}"]');
    if (!scroller || !row) return false;
    const head = row.closest(".check-group").querySelector(".check-group-head");
    const sticky = head ? head.getBoundingClientRect().height : 0;
    const dy = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + dy - sticky - ${gap});
    return Math.round(scroller.scrollTop);
  })()`);
  if (top === false) throw new Error("trophy row " + id + " not found");
  await sleep(200);
  return top;
}

async function scrollChecklistTop() {
  await evaluate(`document.getElementById("list-scroll").scrollTop = 0`);
  await sleep(150);
}

async function scrollDetailToSteps(offset = 16) {
  const info = await evaluate(`(() => {
    const scroller = document.getElementById("detail-scroll");
    const section = document.getElementById("guide-cited-steps");
    const dy = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + dy - ${offset});
    return { top: scroller.scrollTop, steps: document.querySelectorAll("#trophy-steps li").length };
  })()`);
  await sleep(200);
  return info;
}

async function scrollSideToSources(offset = 0) {
  const info = await evaluate(`(() => {
    const scroller = document.getElementById("side-pane");
    const section = document.getElementById("guide-sources-in-this-guide");
    const dy = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + dy - ${offset});
    return { top: scroller.scrollTop, sources: document.querySelectorAll("#trophy-sources li").length };
  })()`);
  await sleep(200);
  return info;
}

async function readGuideSourceRows() {
  return evaluate(`(() => {
    const pane = document.getElementById("side-pane");
    const paneBox = pane.getBoundingClientRect();
    return [...document.querySelectorAll("#trophy-sources li")].map((li) => {
      const link = li.querySelector("a.source-domain");
      const kind = li.querySelector(".source-kind");
      const box = li.getBoundingClientRect();
      const linkStyle = link ? getComputedStyle(link) : null;
      return {
        text: li.textContent.trim().replace(/\\s+/g, " "),
        shown: li.innerText.trim().replace(/\\s+/g, " "),
        domain: link ? link.textContent.trim() : "",
        domainFontSize: linkStyle ? linkStyle.fontSize : "",
        domainColor: linkStyle ? linkStyle.color : "",
        kind: kind ? kind.textContent.trim() : "",
        kindTransform: kind ? getComputedStyle(kind).textTransform : "",
        titleAttr: li.title,
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        visible: box.width > 0 && box.height > 0 && box.top >= paneBox.top - 1 && box.bottom <= paneBox.bottom + 1,
      };
    });
  })()`);
}

async function showRoadmap() {
  await evaluate(`document.getElementById("tab-roadmap").click()`);
  await waitUntil(
    () => evaluate(`!document.getElementById("panel-roadmap").hidden && document.querySelectorAll("#roadmap-stages-to-platinum ol.stages > li.stage").length === 6`),
    "roadmap stages"
  );
  await sleep(300);
}

async function showSources() {
  await evaluate(`document.getElementById("tab-sources").click()`);
  await waitUntil(
    () => evaluate(`!document.getElementById("panel-sources").hidden && document.querySelectorAll("#sources-read-with-dates > li.source-site-group").length > 0`),
    "source register groups"
  );
  await evaluate(`document.querySelector("#panel-sources .panel-scroll").scrollTop = 0`);
  await sleep(300);
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("not a JPEG");
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset + 1] === 0xff) offset += 1;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("could not read JPEG dimensions");
}

async function capture(name) {
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: JPEG_QUALITY,
    fromSurface: true,
    captureBeyondViewport: false,
  }, sessionId);
  const buffer = Buffer.from(shot.data, "base64");
  const file = join(shotsDir, name);
  writeFileSync(file, buffer);
  const size = statSync(file).size;
  const dims = jpegSize(buffer);
  const longSide = Math.max(dims.width, dims.height);
  const shortSide = Math.min(dims.width, dims.height);
  if (size > MAX_BYTES) throw new Error(name + ": " + size + " bytes exceeds " + MAX_BYTES);
  if (longSide > MAX_LONG_SIDE) throw new Error(name + ": long side " + longSide + " exceeds " + MAX_LONG_SIDE);
  if (shortSide < MIN_SHORT_SIDE) throw new Error(name + ": short side " + shortSide + " is below " + MIN_SHORT_SIDE);
  console.log(name + " " + dims.width + "x" + dims.height + " " + size + " bytes");
  return { name, width: dims.width, height: dims.height, bytes: size };
}

async function main() {
  const pids = listeningPids(8080);
  if (pids.length) throw new Error("port 8080 already has a listener (pid " + pids.join(", ") + "); stop it so this script can own and clean up the server");
  if (listeningPids(debugPort).length) throw new Error("port " + debugPort + " is already in use");
  if (!existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath);

  server = spawn(process.execPath, ["serve.ts"], { cwd: root, stdio: "ignore", windowsHide: true });
  await waitForServer();
  console.log("server ready (spawned by shots.mjs)");

  mkdirSync(shotsDir, { recursive: true });
  for (const name of readdirSync(shotsDir)) {
    if (name === ".gitkeep") continue;
    rmSync(join(shotsDir, name), { force: true });
  }

  profile = mkdtempSync(join(tmpdir(), "gta6-shots-"));
  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profile,
    "--window-size=" + WIDTH + "," + HEIGHT,
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const version = await waitForJson("http://127.0.0.1:" + debugPort + "/json/version");
  cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();

  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: WIDTH,
    screenHeight: HEIGHT,
  }, sessionId);

  const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 30000);
  await cdp.send("Page.navigate", { url: appUrl }, sessionId);
  await loaded;
  await sleep(700);
  await waitForRows();

  // 1: the cover dashboard at 31/55, with a trophy open and its cited steps visible.
  await seed(COVER_EARNED, { spoiler: false, tab: "checklist" });
  const coverProgress = await readProgress();
  assertProgress(coverProgress, 31);
  await openTrophy(29, "Fair Game");
  await alignChecklistRow(12);
  const coverDetail = await scrollDetailToSteps(0);
  await evaluate(`document.getElementById("side-pane").scrollTop = 0`);
  await sleep(300);
  const cover = await evaluate(`(() => ({
    title: document.getElementById("detail-title").textContent.trim(),
    badges: [...document.querySelectorAll("#detail-badges .badge, #detail-badges .chip")].map((node) => node.textContent.trim()),
    steps: [...document.querySelectorAll("#trophy-steps li")].map((li) => li.textContent.trim()),
    sources: [...document.querySelectorAll("#trophy-sources li strong")].map((node) => node.textContent.trim()),
    sourceTag: document.getElementById("source-count-tag").textContent.trim(),
    nextUp: document.querySelectorAll("#next-up-list li").length,
  }))()`);
  console.log("cover detail " + JSON.stringify({ ...cover, scrollTop: coverDetail.top }));
  const coverRows = await readGuideSourceRows();
  console.log("cover source rows " + JSON.stringify(coverRows));
  if (coverRows.length !== 6 || coverRows.some((row) => !row.visible)) throw new Error("not all six cover source rows are visible");
  if (cover.nextUp !== 4) throw new Error("expected 4 next-up rows, got " + cover.nextUp);
  await capture("1-checklist.jpg");

  // 2: PMA open, with its numbered cited steps and six source rows in focus.
  await openTrophy(28, "Positive Mental Attitude");
  await alignChecklistRow(28);
  const pmaDetail = await scrollDetailToSteps(0);
  const pmaSide = await scrollSideToSources(0);
  await sleep(300);
  const pma = await evaluate(`(() => ({
    title: document.getElementById("detail-title").textContent.trim(),
    badges: [...document.querySelectorAll("#detail-badges .badge, #detail-badges .chip")].map((node) => node.textContent.trim()),
    steps: document.querySelectorAll("#trophy-steps li").length,
    stepSources: [...document.querySelectorAll("#trophy-steps sup.step-src")].map((node) => node.textContent.trim()),
    sources: [...document.querySelectorAll("#trophy-sources li strong")].map((node) => node.textContent.trim()),
    sourceTag: document.getElementById("source-count-tag").textContent.trim(),
    targetVisible: /18\\s+meditations/i.test(document.body.textContent),
  }))()`);
  if (pma.title !== "Positive Mental Attitude") throw new Error("PMA did not open");
  if (pma.steps !== 4) throw new Error("expected 4 PMA steps, got " + pma.steps);
  if (pma.sources.length !== 6) throw new Error("expected 6 PMA source rows, got " + pma.sources.length);
  const sourceRow = await evaluate(`(() => {
    const row = document.querySelector("#trophy-sources li");
    const link = row && row.querySelector("a");
    return row ? {
      text: row.textContent.trim().replace(/\\s+/g, " "),
      linkText: link ? link.textContent.trim() : null,
      linkTitle: link ? link.title : null,
    } : null;
  })()`);
  console.log("source row " + JSON.stringify(sourceRow));
  console.log("pma detail " + JSON.stringify({ ...pma, detailScroll: pmaDetail.top, sideScroll: pmaSide.top }));
  const pmaRows = await readGuideSourceRows();
  console.log("pma source rows " + JSON.stringify(pmaRows));
  if (pmaRows.length !== 6 || pmaRows.some((row) => !row.visible)) throw new Error("not all six PMA source rows are visible");
  await capture("2-guide-sources.jpg");

  await openTrophy(1, "Vice Got a Price!");
  await evaluate(`document.getElementById("side-pane").scrollTop = 0`);
  await sleep(200);
  const threeSourceRows = await readGuideSourceRows();
  console.log("three-source rows " + JSON.stringify(threeSourceRows));
  if (threeSourceRows.length !== 3 || threeSourceRows.some((row) => !row.visible)) throw new Error("not all three source rows are visible");

  // 3: the Sources tab with the whole register grouped by site.
  await showSources();
  const sourcesRegister = await evaluate(`(() => ({
    earned: document.getElementById("earned-count").textContent.trim(),
    percent: document.getElementById("percent").textContent.trim(),
    groups: [...document.querySelectorAll("#sources-read-with-dates > li.source-site-group")].map((group) => ({
      site: group.querySelector(".source-site-domain").textContent.trim(),
      count: group.querySelectorAll("li.source-row").length,
      heading: group.querySelector(".source-site-count").textContent.trim(),
    })),
    rows: document.querySelectorAll("#sources-read-with-dates li.source-row").length,
    rowsWithDomainAndDate: [...document.querySelectorAll("#sources-read-with-dates li.source-row")].filter((row) => row.querySelector(".source-meta a") && /read \\d{2} [A-Z][a-z]{2} \\d{4}/.test(row.querySelector(".source-meta").textContent)).length,
    summary: document.getElementById("sources-summary").textContent.trim(),
    auditSites: document.getElementById("audit-sites").textContent.trim(),
    auditBacked: document.getElementById("audit-backed-steps").textContent.trim(),
  }))()`);
  if (sourcesRegister.earned !== "31") throw new Error("sources tab lost seeded progress: " + sourcesRegister.earned);
  if (sourcesRegister.groups.length !== 3) throw new Error("expected 3 site groups, got " + sourcesRegister.groups.length);
  if (sourcesRegister.rows !== 24) throw new Error("expected 24 register rows, got " + sourcesRegister.rows);
  if (sourcesRegister.rowsWithDomainAndDate !== 24) throw new Error("register rows are missing a domain or read date");
  console.log("sources register " + JSON.stringify(sourcesRegister));
  await capture("3-sources-register.jpg");

  // 4: roadmap with the same 31/55 and all six stages.
  await showRoadmap();
  await evaluate(`document.getElementById("roadmap-stages-to-platinum").scrollTop = 0`);
  await sleep(300);
  const road = await evaluate(`(() => ({
    earned: document.getElementById("earned-count").textContent.trim(),
    percent: document.getElementById("percent").textContent.trim(),
    summary: document.querySelector("#roadmap-stages-to-platinum .roadmap-summary").textContent.trim(),
    stages: [...document.querySelectorAll("#roadmap-stages-to-platinum ol.stages > li.stage")].map((card) => ({
      title: card.querySelector(".stage-title").textContent.trim(),
      count: card.querySelector(".stage-progress").textContent.trim(),
      missableChips: card.querySelectorAll('.tchip[data-missable="true"]').length,
    })),
    missableCards: document.querySelectorAll("#roadmap-stages-to-platinum .info-card--warn").length,
  }))()`);
  if (road.stages.length !== 6) throw new Error("expected 6 roadmap stages, got " + road.stages.length);
  if (road.earned !== "31") throw new Error("roadmap lost seeded progress: " + road.earned);
  console.log("roadmap " + JSON.stringify(road));
  await capture("4-roadmap.jpg");

  console.log("all four screenshots captured within caps");
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (cdp) {
      try { await cdp.send("Browser.close"); } catch {}
      cdp.close();
      cdp = null;
    }
    killTree(chrome);
    chrome = null;
    killTree(server);
    server = null;
    await sleep(800);
    for (const port of [8080, debugPort]) {
      for (const pid of listeningPids(port)) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 });
        } catch {}
      }
    }
    await sleep(500);
    for (const port of [8080, debugPort]) {
      const left = listeningPids(port);
      if (left.length) {
        console.error("port " + port + " still has listener(s): " + left.join(", "));
        process.exitCode = 1;
      }
    }
    if (profile) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
      profile = null;
    }
  });
