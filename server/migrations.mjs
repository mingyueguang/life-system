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
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()){
   database.exec(`
    ALTER TABLE agent_jobs ADD COLUMN claimed_key_id TEXT;
    ALTER TABLE agent_jobs ADD COLUMN capability TEXT NOT NULL DEFAULT 'analysis';
    ALTER TABLE agent_jobs ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agent_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_jobs ADD COLUMN effect INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_jobs ADD COLUMN day TEXT;
    ALTER TABLE agent_jobs ADD COLUMN base_version INTEGER;
    UPDATE agent_jobs SET claimed_key_id=target_key_id WHERE status!='queued';
    CREATE TABLE executors(key_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,capabilities TEXT NOT NULL,max_parallel INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1,last_seen INTEGER);
    CREATE TABLE daily_days(user_id TEXT NOT NULL,day TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,input TEXT NOT NULL,plan TEXT,confirmed INTEGER NOT NULL DEFAULT 0,feedback TEXT NOT NULL DEFAULT '{}',review TEXT,updated INTEGER NOT NULL,PRIMARY KEY(user_id,day));
    CREATE TABLE life_settings(user_id TEXT PRIMARY KEY,body TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(3);
   `);
  }
  database.exec('COMMIT');
 }catch(e){database.exec('ROLLBACK');throw e}
}
