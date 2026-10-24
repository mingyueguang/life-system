import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
let instance;
export function db(){if(instance)return instance;const file=resolve(process.env.DATABASE_PATH||'./data/life.sqlite');mkdirSync(dirname(file),{recursive:true,mode:0o700});const database=new DatabaseSync(file);database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');database.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY CHECK(id='owner'),email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('read','write')),created_at TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,payload TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_records_user_kind ON records(user_id,kind,deleted);
CREATE INDEX IF NOT EXISTS idx_records_user_updated ON records(user_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
`);instance=database;return database;}
export function closeDb(){instance?.close();instance=undefined;}
export function transaction(action){const database=db();database.exec('BEGIN IMMEDIATE');try{const value=action(database);database.exec('COMMIT');return value;}catch(e){database.exec('ROLLBACK');throw e;}}
