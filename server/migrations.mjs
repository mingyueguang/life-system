// Additive feature migration. The key table rebuild preserves IDs, hashes and expiry.
export function migrate(database){
 database.exec('BEGIN IMMEDIATE');
 try{
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()){
   database.exec(`
    CREATE TABLE api_keys_v2(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('read','write','worker')),created_at TEXT NOT NULL,expires_at INTEGER NOT NULL);
    INSERT INTO api_keys_v2 SELECT * FROM api_keys;
    DROP TABLE api_keys;
    ALTER TABLE api_keys_v2 RENAME TO api_keys;
    CREATE TABLE agent_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),target_key_id TEXT NOT NULL,idem TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','needs_review','cancelled')),lease TEXT,expires INTEGER,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,idem));
    CREATE INDEX idx_agent_jobs_claim ON agent_jobs(user_id,target_key_id,status,created);
    CREATE TABLE agent_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),key_id TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE agent_audit(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,event TEXT NOT NULL,job_id TEXT,created INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES(2);
   `);
  }
  database.exec('COMMIT');
 }catch(e){database.exec('ROLLBACK');throw e}
}
