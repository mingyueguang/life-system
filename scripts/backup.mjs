import {backup} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {db,closeDb} from '../server/database.mjs';
const destination=resolve(process.argv[2]||`./backups/life-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
await backup(db(),destination);closeDb();console.log('Backup saved:',destination);
