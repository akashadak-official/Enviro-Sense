// Builds seed/enviro-seed.db.gz: a small copy of your NASA satellite data (no users, no readings).
// Run on your laptop with the server stopped:   npm run seed
// Options:  --src=enviro.db   --out=seed/enviro-seed.db.gz   --from=2024-01-01
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : def;
};
const root = path.join(__dirname, '..');
const src = path.resolve(root, arg('src', 'enviro.db'));
const out = path.resolve(root, arg('out', 'seed/enviro-seed.db.gz'));
const from = arg('from', '');
const tmp = out.replace(/\.gz$/, '') + '.tmp';

if (!fs.existsSync(src)) { console.error('Cannot find ' + src); process.exit(1); }
if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) { console.error('--from must look like 2024-01-01'); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

const source = new Database(src, { readonly: true });
const ddl = source.prepare(
  "SELECT sql FROM sqlite_master WHERE tbl_name IN ('fire_cells','fire_cell_windows') AND sql IS NOT NULL ORDER BY type DESC"
).all().map(r => r.sql);
if (!ddl.length) { console.error('No satellite tables in ' + src + '. Run the NASA download first.'); process.exit(1); }
source.close();

const db = new Database(tmp);
for (const sql of ddl) db.exec(sql);
db.prepare('ATTACH DATABASE ? AS src').run(src);

console.log('Copying satellite rows' + (from ? ' from ' + from : '') + ' ...');
db.prepare('INSERT INTO fire_cells SELECT * FROM src.fire_cells WHERE date >= ? ORDER BY cy, cx, date, sensor').run(from || '0000-00-00');
db.prepare('INSERT INTO fire_cell_windows SELECT * FROM src.fire_cell_windows WHERE start >= ?').run(from || '0000-00-00');
db.exec('DETACH DATABASE src');

const rows = db.prepare('SELECT COUNT(*) c, MIN(date) a, MAX(date) b FROM fire_cells').get();
db.pragma('journal_mode = DELETE');
db.exec('VACUUM');
db.close();

const rawSize = fs.statSync(tmp).size;
console.log('Compressing ' + (rawSize / 1048576).toFixed(0) + ' MB ...');
fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }));
fs.unlinkSync(tmp);

const mb = fs.statSync(out).size / 1048576;
console.log(`\nDone: ${out}\n  ${rows.c.toLocaleString()} cells, ${rows.a} to ${rows.b}\n  size ${mb.toFixed(1)} MB`);
if (mb > 90) console.log('\nWARNING: GitHub refuses files over 100 MB. Run again with --from=2024-01-01 (or a later date) to make it smaller.');
else if (mb > 50) console.log('\nNote: GitHub warns about files over 50 MB, but it still accepts them up to 100 MB.');
