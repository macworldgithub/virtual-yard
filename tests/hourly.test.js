const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../Leads/run-hourly');
const { scrapeCombo, processRows, fetchPage } = require('../Leads/Scraper');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-hourly-'));
  fs.mkdirSync(path.join(root, 'importer/seed'), { recursive: true });
  fs.writeFileSync(path.join(root, 'importer/seed/upsert-both.js'), '');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/both.json'), 'previous snapshot');
  t.after(() => {
    // Only test-created files inside the returned temporary directory.
    for (const dir of [path.join(root, 'data/backups'), path.join(root, 'data'), path.join(root, 'importer/seed'), path.join(root, 'importer')]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); }
      fs.rmdirSync(dir);
    }
    fs.rmdirSync(root);
  });
  return { backendRoot: root, importerRoot: path.join(root, 'importer'), dataDir: path.join(root, 'data'), databaseUri: 'mongodb://invalid.example/test' };
}
const source = { scrapedAt: '2026-10-31T10:00:00Z', summary: { totalLeads: 1, totalTestDrives: 0 }, leads: [{ leadId: '100' }], testDrives: [] };

test('hourly job validates, backs up, upserts, then publishes the new both.json', async t => {
  const config = fixture(t);
  const calls = [];
  await run({ ...config, async runCommand(script, args, env) {
    assert.equal(env.MONGO_URI, config.databaseUri);
    calls.push(path.basename(script) + (args.includes('--dry-run') ? ':dry-run' : ''));
    if (path.basename(script) === 'Scraper.js') fs.writeFileSync(env.VY_OUTPUT_FILE, JSON.stringify(source));
    else {
      assert.equal(fs.readFileSync(path.join(config.dataDir, 'both.json'), 'utf8'), 'previous snapshot');
      if (!args.includes('--dry-run')) assert.ok(args.some(arg => arg.startsWith('--backup=')));
    }
  } });
  assert.deepEqual(calls, ['Scraper.js', 'upsert-both.js:dry-run', 'upsert-both.js']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'both.json'))), source);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'last-run.json'))).status, 'succeeded');
});

for (const failure of ['scrape', 'import']) test(`${failure} failure leaves the previous snapshot intact`, async t => {
  const config = fixture(t);
  let imported = false;
  await assert.rejects(run({ ...config, async runCommand(script, args, env) {
    if (path.basename(script) === 'Scraper.js') {
      if (failure === 'scrape') throw new Error('Expired session');
      fs.writeFileSync(env.VY_OUTPUT_FILE, JSON.stringify(source));
    } else { imported = true; throw new Error('Import failed'); }
  } }));
  assert.equal(imported, failure === 'import');
  assert.equal(fs.readFileSync(path.join(config.dataDir, 'both.json'), 'utf8'), 'previous snapshot');
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'last-run.json'))).status, 'failed');
});

test('pagination uses actual rows even when recordsTotal is zero', async () => {
  const rows = [['', '<button data-id="2"></button>', '<a class="loadPage">Driver</a>', '<a class="loadPage">BYD ATTO 3</a>', '', '', 'NEW', '<a href="?leadId=100"></a>']];
  const records = [];
  await scrapeCombo({ label: 'Leads', type: 'lead', menuId: 245 }, 0, 'inbox', 0, 'new', new Set(), records,
    { async fetchPage(menu, tab, stage, start) { return { recordsTotal: 0, data: start ? [] : rows }; }, async sleep() {} });
  assert.equal(records.length, 1);
  assert.equal(records[0].leadId, '100');
});

test('failed pagination and malformed rows fail the scrape instead of accepting partial data', async () => {
  let calls = 0;
  const rows = [['', '', '<a class="loadPage">Driver</a>', '', '', '', '', 'leadId=100']];
  await assert.rejects(scrapeCombo({ label: 'Leads', type: 'lead', menuId: 245 }, 0, 'inbox', 0, 'new', new Set(), [],
    { async fetchPage() { calls++; if (calls === 1) return { recordsTotal: 1, data: rows }; throw new Error('Network failed'); }, async sleep() {} }), /All retries failed/);
  assert.equal(calls, 4);
  assert.throws(() => processRows([null], 'lead', 'inbox', 'new', new Set(), []), /Row parsing failed/);
});

test('native end-of-list envelopes without data are accepted, while malformed responses fail', async t => {
  const session = require('../../byd-sales-floor-backend/src/services/virtualyardSession');
  const original = session.json;
  t.after(() => { session.json = original; });
  session.json = async () => ({ recordsTotal: 310, recordsFiltered: 310 });
  assert.deepEqual((await fetchPage(245, 0, 0, 350)).data, []);
  session.json = async () => ({ error: 'Access denied', recordsTotal: 0, recordsFiltered: 0 });
  await assert.rejects(fetchPage(245, 0, 0, 350), /Invalid Virtual Yard/);
  session.json = async () => ({ unexpected: true });
  await assert.rejects(fetchPage(245, 0, 0, 350), /Invalid Virtual Yard/);
});
