// main.ts — this entry's own build program (Node 22, standard library only, no dependencies).
// It preflights the guide before handing it in: the required app/ files, all 55 trophies with real
// guides, a roadmap that covers each trophy exactly once, and 1-4 captioned screenshots. Only when
// every check passes does it copy app/ and screenshots/ to MAKEFUN_OUTPUT_DIR (default /output) and
// write dossier.json last, with the vendored make.fun library left exactly as handed out.
// Run it with: MAKEFUN_OUTPUT_DIR=out node main.ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-frontend.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const TROPHY_TOTAL = 55;
const GUIDE_MIN_CHARS = 40;
const SHOT_MAX = 4;
const SHOT_MAX_BYTES = 262144;
const SHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const REQUIRED_APP_FILES = ['index.html', 'app.js', 'style.css', 'data/trophies.json', 'data/roadmap.json'];

function log(message) {
  process.stdout.write(`[preflight] ${message}\n`);
}

function fail(message) {
  writeSync(2, `[preflight] FAIL: ${message}\n`);
  process.exit(1);
}

function describeNames(names, limit = 12) {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown}, and ${names.length - limit} more` : shown;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(`${label} is missing or unreadable (${path})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} is not valid JSON (${path}): ${error.message}`);
  }
}
function checkRequiredFiles() {
  const broken = [];
  for (const relative of REQUIRED_APP_FILES) {
    const path = join(here, 'app', relative);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) broken.push(relative);
  }
  if (broken.length > 0) fail(`app/ is incomplete or has empty files: ${broken.join(', ')}`);
  log(`required app files present: ${REQUIRED_APP_FILES.join(', ')}`);
}

function loadTrophies() {
  const path = join(here, 'app', 'data', 'trophies.json');
  const data = readJson(path, 'app/data/trophies.json');
  const list = Array.isArray(data) ? data : Array.isArray(data?.trophies) ? data.trophies : null;
  if (!list) fail('app/data/trophies.json must be an array or an object with a trophies array');
  if (list.length !== TROPHY_TOTAL) fail(`app/data/trophies.json has ${list.length} trophies, expected exactly ${TROPHY_TOTAL}`);
  const broken = [];
  const duplicates = [];
  const seen = new Set();
  list.forEach((trophy, index) => {
    const name = typeof trophy?.name === 'string' ? trophy.name.trim() : '';
    const label = name || `#${index + 1}`;
    const problems = [];
    if (!name) problems.push('name');
    if (typeof trophy?.description !== 'string' || trophy.description.trim() === '') problems.push('description');
    if (typeof trophy?.grade !== 'string' || trophy.grade.trim() === '') problems.push('grade');
    if (typeof trophy?.guide !== 'string' || trophy.guide.trim() === '') problems.push('guide');
    else if (trophy.guide.trim().length < GUIDE_MIN_CHARS) problems.push(`guide shorter than ${GUIDE_MIN_CHARS} chars`);
    if (problems.length > 0) broken.push(`${label}: ${problems.join(', ')}`);
    if (name) {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
  });
  if (duplicates.length > 0) fail(`duplicate trophy names: ${describeNames(duplicates)}`);
  if (broken.length > 0) fail(`invalid trophies: ${describeNames(broken)}`);
  log(`trophies: ${list.length} entries, each with name, description, grade and a ${GUIDE_MIN_CHARS}+ char guide`);
  return list;
}

function checkRoadmap(trophies) {
  const roadmap = readJson(join(here, 'app', 'data', 'roadmap.json'), 'app/data/roadmap.json');
  if (!Array.isArray(roadmap?.stages)) fail('app/data/roadmap.json must have a stages array');
  const known = new Set(trophies.map((trophy) => trophy.name.trim()));
  const counts = new Map();
  for (const name of known) counts.set(name, 0);
  for (const stage of roadmap.stages) {
    const title = stage?.title ?? '(untitled stage)';
    if (!Array.isArray(stage?.trophies)) fail(`roadmap stage "${title}" has no trophies array`);
    for (const name of stage.trophies) {
      if (typeof name !== 'string') fail(`roadmap stage "${title}" contains a non-string trophy name`);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const missing = [];
  const repeated = [];
  for (const [name, count] of counts) {
    if (count === 0) missing.push(name);
    else if (count > 1) repeated.push(`${name} x${count}`);
  }
  const unknown = [...counts.keys()].filter((name) => !known.has(name));
  const parts = [];
  if (missing.length > 0) parts.push(`missing from stages: ${describeNames(missing)}`);
  if (repeated.length > 0) parts.push(`named more than once: ${describeNames(repeated)}`);
  if (unknown.length > 0) parts.push(`not in the trophy list: ${describeNames(unknown)}`);
  if (parts.length > 0) fail(`roadmap stages do not cover the ${TROPHY_TOTAL} trophies exactly once (${parts.join('; ')})`);
  if (!Array.isArray(roadmap.missables)) fail('app/data/roadmap.json must have a missables array');
  const stray = roadmap.missables.filter((name) => typeof name !== 'string' || !known.has(name));
  if (stray.length > 0) fail(`roadmap missables name trophies that do not exist: ${describeNames(stray.map((name) => String(name)))}`);
  log(`roadmap: ${roadmap.stages.length} stages cover all ${trophies.length} trophies exactly once; ${roadmap.missables.length} missables listed`);
}
function checkScreenshots() {
  const dir = join(here, 'screenshots');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail('screenshots/ directory is missing');
  const shots = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile() && SHOT_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort();
  if (shots.length < 1 || shots.length > SHOT_MAX) fail(`screenshots/ has ${shots.length} image(s), expected 1 to ${SHOT_MAX} .png/.jpg/.jpeg files`);
  const tooBig = shots.filter((name) => statSync(join(dir, name)).size > SHOT_MAX_BYTES);
  if (tooBig.length > 0) fail(`screenshots larger than ${SHOT_MAX_BYTES} bytes: ${describeNames(tooBig)}`);
  const manifestPath = existsSync(join(dir, 'shots.json')) ? join(dir, 'shots.json') : join(here, 'shots.json');
  if (!existsSync(manifestPath)) fail('shots.json is missing (looked in screenshots/ and the entry root)');
  const manifest = readJson(manifestPath, 'shots.json');
  const described = Array.isArray(manifest) ? manifest : Array.isArray(manifest?.screenshots) ? manifest.screenshots : null;
  if (!described) fail('shots.json must be an array or an object with a screenshots array');
  const named = new Set(described.map((entry) => {
    const file = typeof entry === 'string' ? entry : typeof entry?.file === 'string' ? entry.file : '';
    return basename(file);
  }));
  const undocumented = shots.filter((name) => !named.has(name));
  if (undocumented.length > 0) fail(`shots.json does not describe: ${describeNames(undocumented)}`);
  log(`screenshots: ${shots.length} image(s), each at most ${SHOT_MAX_BYTES} bytes, all described by shots.json`);
  return shots;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function copyEntry(shots) {
  mkdirSync(out, { recursive: true });
  cpSync(join(here, 'app'), join(out, 'app'), { recursive: true });
  mkdirSync(join(out, 'screenshots'), { recursive: true });
  if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
  const copiedIndex = join(out, 'app', 'index.html');
  if (!existsSync(copiedIndex) || statSync(copiedIndex).size === 0) fail(`copy failed: ${copiedIndex} is missing or empty`);
  const appFiles = countFiles(join(out, 'app'));
  if (appFiles < REQUIRED_APP_FILES.length) fail(`copy failed: only ${appFiles} app files reached ${join(out, 'app')}`);
  const copiedShots = readdirSync(join(out, 'screenshots'))
    .filter((name) => statSync(join(out, 'screenshots', name)).isFile() && SHOT_EXTENSIONS.has(extname(name).toLowerCase()));
  if (copiedShots.length !== shots.length) fail(`copy failed: ${copiedShots.length} screenshot(s) reached ${join(out, 'screenshots')}, expected ${shots.length}`);
  log(`copied app/ (${appFiles} files) and ${copiedShots.length} screenshot(s) to ${out}`);
  return appFiles;
}

function main() {
  log(`preflighting the entry at ${here}`);
  checkRequiredFiles();
  const trophies = loadTrophies();
  checkRoadmap(trophies);
  const shots = checkScreenshots();
  const appFiles = copyEntry(shots);
  const dossier = buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, app_max_files: 993, app_max_bytes: 50331648 });
  writeFileSync(join(out, 'dossier.json'), dossier);
  const dossierBytes = statSync(join(out, 'dossier.json')).size;
  log(`wrote ${out}: ${trophies.length} trophies, ${shots.length} screenshots, ${appFiles} app files, ${dossierBytes}-byte dossier.json`);
}

main();