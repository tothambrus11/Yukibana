// Makes an address the first admin of the LOCAL database, after that person
// has logged in once. Runs psql inside the database container, so it works
// from the host and from the devcontainer alike, with nothing installed.
//
//   node cloud/dev/scripts/local-admin.mjs you@example.com
import { execFileSync } from 'node:child_process';

const addr = process.argv[2];
if (!addr) {
  console.error('usage: node cloud/dev/scripts/local-admin.mjs <email>');
  process.exit(2);
}
const sql = `select app.bootstrap_admin('${addr.replace(/'/g, "''")}') as promoted`;
const out = execFileSync('docker', ['exec', '-i', 'supabase_db_yukibana', 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-c', sql], { encoding: 'utf8' });
console.log(out.trim() === 't' ? `${addr} is now the admin` : `nothing changed: an admin already exists (or use the admin screen)`);
