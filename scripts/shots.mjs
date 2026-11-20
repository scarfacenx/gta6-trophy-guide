// scripts/shots.mjs: capture the four evidence screenshots over CDP.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shotsDir = join(root, "screenshots");
const appUrl = "http://localhost:8080/";
const chromePath = "C:/Users/Administrator/AppData/Local/BrowserClaw/Application/chrome.exe";
const port = 9333;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function curlStatus() {
  try {
    return execFileSync("curl.exe", ["-s", "-o", "NUL", "-w", "%{http_code}", appUrl], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
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
let server;
let chrome;
let cdp;
let sessionId;

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

const waitRows = () => waitUntil(
  async () => (await evaluate(`document.querySelectorAll("li.trophy").length`)) === 55,
  "55 trophy rows"
);

async function reloadApp() {
  const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 30000);
  await cdp.send("Page.reload", { ignoreCache: true }, sessionId);
  await loaded;
  await sleep(800);
  await waitRows();
}

async function capture(name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(join(shotsDir, name), Buffer.from(shot.data, "base64"));
  console.log(name, "captured");
}

async function main() {
  server = spawn(process.execPath, ["serve.ts"], { cwd: root, stdio: "ignore" });
  await waitForServer();
  console.log("server ready");

  mkdirSync(shotsDir, { recursive: true });
  for (const name of readdirSync(shotsDir)) {
    if (name === ".gitkeep") continue;
    rmSync(join(shotsDir, name), { force: true });
  }

  const profile = mkdtempSync(join(tmpdir(), "gta6-shots-"));
  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: "ignore" });

  const version = await waitForJson("http://127.0.0.1:" + port + "/json/version");
  cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();

  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

  const loaded = cdp.waitEvent("Page.loadEventFired", sessionId, 30000);
  await cdp.send("Page.navigate", { url: appUrl }, sessionId);
  await loaded;
  await sleep(800);
  await waitRows();
  // 1: checklist at the top.
  await evaluate(`localStorage.clear()`);
  await reloadApp();
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(300);
  await capture("1-checklist.png");

  // 2: a missable trophy detail.
  const opened = await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll("li.trophy")).find((item) => item.textContent.includes("Fair Game"));
    if (!row) return false;
    row.querySelector(".trophy-main").click();
    return true;
  })()`);
  if (!opened) throw new Error("Fair Game row not found");
  await waitUntil(
    () => evaluate(`document.getElementById("detail-dialog").open && document.getElementById("detail-guide").textContent.length > 0`),
    "detail dialog"
  );
  await sleep(400);
  const detail = await evaluate(`(() => {
    const dialog = document.getElementById("detail-dialog");
    return {
      title: document.getElementById("detail-title").textContent,
      missable: dialog.querySelector(".badge--missable") !== null,
      tips: document.querySelectorAll("#detail-tips li").length,
      sources: document.querySelectorAll("#detail-sources li").length,
    };
  })()`);
  console.log("detail", JSON.stringify(detail));
  await capture("2-trophy-detail.png");
  await evaluate(`document.getElementById("detail-close").click()`);
  await sleep(250);

  // 3: roadmap with all six stages.
  await evaluate(`localStorage.clear()`);
  await reloadApp();
  await evaluate(`document.getElementById("tab-roadmap").click()`);
  await waitUntil(
    () => evaluate(`!document.getElementById("panel-roadmap").hidden && document.querySelectorAll("#roadmap-root ol.stages > li.stage").length === 6`),
    "roadmap stages"
  );
  await sleep(400);
  const fit = await evaluate(`(() => {
    const panel = document.getElementById("panel-roadmap");
    const root = document.getElementById("roadmap-root");
    panel.scrollIntoView({ block: "start" });
    const room = window.innerHeight - 20;
    let scale = Math.min(1, room / root.getBoundingClientRect().height);
    root.style.transformOrigin = "top left";
    for (let pass = 0; pass < 4; pass += 1) {
      root.style.width = (100 / scale) + "%";
      root.style.transform = "scale(" + scale + ")";
      const height = root.getBoundingClientRect().height;
      if (height <= room) break;
      scale *= room / height;
    }
    root.style.width = (100 / scale) + "%";
    root.style.transform = "scale(" + scale + ")";
    return {
      stages: document.querySelectorAll("#roadmap-root ol.stages > li.stage").length,
      chips: document.querySelectorAll("#roadmap-root .tchip").length,
      scale: Math.round(scale * 1000) / 1000,
      height: Math.round(root.getBoundingClientRect().height),
    };
  })()`);
  console.log("roadmap", JSON.stringify(fit));
  await sleep(400);
  await capture("3-roadmap.png");

  // 4: spoiler mode on with 12 real checkbox clicks.
  await evaluate(`localStorage.clear()`);
  await reloadApp();
  const ticked = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll("li.trophy")).filter((row) => {
      const kind = row.querySelector(".chip--kind");
      return kind && kind.textContent.trim() !== "Story" && !row.querySelector("input.earn").checked;
    });
    const chosen = rows.slice(0, 12);
    for (const row of chosen) row.querySelector("input.earn").click();
    return chosen.length;
  })()`);
  if (ticked !== 12) throw new Error("expected 12 ticks, got " + ticked);
  await evaluate(`document.getElementById("spoiler-toggle").click()`);
  await sleep(500);
  const progress = await evaluate(`(() => ({
    earned: document.getElementById("earned-count").textContent,
    percent: document.getElementById("percent").textContent,
    spoiler: document.getElementById("spoiler-toggle").checked,
    locked: document.querySelectorAll("li.trophy[data-locked=true]").length,
    visible: document.querySelectorAll("li.trophy").length,
    search: document.getElementById("search") !== null,
    clearFilters: document.getElementById("clear-filters") !== null,
  }))()`);
  console.log("spoiler", JSON.stringify(progress));
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(300);
  await capture("4-spoiler-progress.png");
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
    }
    if (chrome) chrome.kill();
    if (server) server.kill();
    await sleep(300);
  });