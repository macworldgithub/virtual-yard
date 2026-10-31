const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function execute(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(script)} failed (${signal || code})`)));
  });
}
function writeStatus(file, status) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(status, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function pruneBackups(directory) {
  const cutoff = Date.now() - 7 * 86400000;
  for (const name of fs.readdirSync(directory)) {
    if (!/^virtualyard-before-\d{4}-\d{2}-\d{2}T[\dTZ-]+-\d+\.ejson$/.test(name)) continue;
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

async function run({ backendRoot, importerRoot, dataDir, databaseUri, runCommand = execute }) {
  if (!databaseUri) throw new Error('LEAD_CENTER_MONGO_URI is required for the hourly import');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-') + `-${process.pid}`;
  const pending = path.join(dataDir, `both-${stamp}.pending.json`);
  const snapshot = path.join(dataDir, 'both.json');
  const backup = path.join(backupDir, `virtualyard-before-${stamp}.ejson`);
  const statusFile = path.join(dataDir, 'last-run.json');
  const env = { ...process.env, MONGO_URI: databaseUri, VY_OUTPUT_FILE: pending,
    VIRTUALYARD_SESSION_FILE: process.env.VIRTUALYARD_SESSION_FILE || path.join(backendRoot, '.runtime/virtualyard-session.json') };
  const status = { status: 'running', startedAt, snapshot, pending, backup };
  writeStatus(statusFile, status);
  try {
    const importer = path.join(importerRoot, 'seed/upsert-both.js');
    if (!fs.existsSync(importer)) throw new Error('Virtual Yard upsert importer is not installed');
    await runCommand(path.join(__dirname, 'Scraper.js'), [], env);
    const payload = JSON.parse(fs.readFileSync(pending, 'utf8'));
    if (!Array.isArray(payload.leads) || !Array.isArray(payload.testDrives) || !payload.leads.length && !payload.testDrives.length) throw new Error('Scrape did not produce a non-empty complete snapshot');
    await runCommand(importer, [pending, '--dry-run'], env);
    await runCommand(importer, [pending, `--backup=${backup}`], env);
    // Publish the canonical snapshot only after the importer verifies the upsert.
    if (fs.existsSync(snapshot)) fs.copyFileSync(snapshot, path.join(dataDir, 'both.previous.json'));
    fs.renameSync(pending, snapshot);
    pruneBackups(backupDir);
    const result = { ...status, status: 'succeeded', finishedAt: new Date().toISOString(), summary: payload.summary };
    writeStatus(statusFile, result);
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    writeStatus(statusFile, { ...status, status: 'failed', finishedAt: new Date().toISOString(), message: error.message });
    throw error;
  }
}

async function main() {
  const backendRoot = path.resolve(process.env.VY_BACKEND_ROOT || path.join(__dirname, '../../byd-sales-floor-backend'));
  require('dotenv').config({ path: path.join(backendRoot, '.env'), quiet: true });
  return run({ backendRoot, importerRoot: path.resolve(process.env.VY_IMPORTER_ROOT || path.join(__dirname, '../../byd-leads-backend')),
    dataDir: path.resolve(process.env.VY_SYNC_DATA_DIR || path.join(backendRoot, '.runtime/virtualyard')),
    databaseUri: process.env.LEAD_CENTER_MONGO_URI });
}
module.exports = { run, main };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ status: 'failed', message: error.message })); process.exitCode = 1; });
