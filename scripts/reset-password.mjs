import {passwordHash} from '../server/auth.mjs';
import {db,transaction,closeDb} from '../server/database.mjs';
if(process.stdin.isTTY){console.error('通过标准输入传入新密码，不要把密码放入命令参数。参见 DEPLOYMENT.md。');process.exit(1)}
let password='';for await (const part of process.stdin){password+=part;if(password.length>1024)throw Error('Password too long')}
password=password.replace(/\r?\n$/,'');if(!db().prepare("SELECT 1 FROM users WHERE id='owner'").get())throw Error('Owner not registered');const encoded=await passwordHash(password);transaction(database=>{database.prepare("UPDATE users SET password_hash=? WHERE id='owner'").run(encoded);database.exec('DELETE FROM sessions; DELETE FROM api_keys; DELETE FROM rate_limits;');});closeDb();console.log('Password changed. All sessions and AI keys revoked.');
