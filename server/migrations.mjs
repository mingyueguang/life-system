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
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=4').get()){
   database.exec(`
    CREATE TABLE record_metadata(record_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE record_history(record_id TEXT NOT NULL,user_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL,actor TEXT NOT NULL,changed_at TEXT NOT NULL,PRIMARY KEY(record_id,version));
    CREATE TABLE record_requests(user_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
    CREATE INDEX idx_record_history_user ON record_history(user_id,record_id,version);
    INSERT INTO schema_migrations VALUES(4);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=5').get()){
   database.exec(`
    CREATE TABLE intake_fields(user_id TEXT NOT NULL,field_key TEXT NOT NULL,record_id TEXT,record_version INTEGER,deferred INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,evidence TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(user_id,field_key));
    CREATE TABLE intake_reports(user_id TEXT NOT NULL,domain TEXT NOT NULL,job_id TEXT NOT NULL,context_hash TEXT NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(user_id,domain));
    CREATE TABLE intake_requests(user_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
    INSERT INTO schema_migrations VALUES(5);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=6').get()){
   database.exec(`
    CREATE TABLE raw_inputs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT,method TEXT NOT NULL DEFAULT 'unknown',original_text TEXT NOT NULL DEFAULT '',reference TEXT NOT NULL DEFAULT '',occurred_at TEXT,attachments TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,actor TEXT NOT NULL DEFAULT 'website',UNIQUE(user_id,request_id));
    CREATE INDEX idx_raw_inputs_user_created ON raw_inputs(user_id,created_at);
    ALTER TABLE records ADD COLUMN source_id TEXT REFERENCES raw_inputs(id);
    CREATE INDEX idx_records_source ON records(user_id,source_id);
    INSERT INTO schema_migrations VALUES(6);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=7').get()){
   database.exec(`
    ALTER TABLE daily_days ADD COLUMN fitness TEXT;
    ALTER TABLE daily_days ADD COLUMN diet TEXT;
    INSERT INTO schema_migrations VALUES(7);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=8').get()){
   database.exec(`
    CREATE TABLE domain_plans(user_id TEXT NOT NULL REFERENCES users(id),domain TEXT NOT NULL CHECK(domain IN ('work','fitness','diet')),version INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('candidate','confirmed','needs_review','superseded','rejected')),confirmed_at TEXT,review_at TEXT NOT NULL,source_job_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,domain,version));
    CREATE INDEX idx_domain_plans_latest ON domain_plans(user_id,domain,status,version);
    INSERT INTO schema_migrations VALUES(8);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=9').get()){
   database.exec(`
    CREATE TABLE domain_state_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,day TEXT NOT NULL,domain TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('insufficient','normal','attention','adjust')),decision TEXT NOT NULL CHECK(decision IN ('reuse','analyze')),reasons TEXT NOT NULL DEFAULT '[]',missing TEXT NOT NULL DEFAULT '[]',plan_version INTEGER,plan_review_at TEXT,created_at TEXT NOT NULL);
    CREATE INDEX idx_domain_state_log_lookup ON domain_state_log(user_id,day,domain,id);
    INSERT INTO schema_migrations VALUES(9);
   `);
  }
  if(!database.prepare('SELECT 1 FROM schema_migrations WHERE version=10').get()){
   database.exec(`
    ALTER TABLE domain_plans ADD COLUMN basis_hash TEXT;
    CREATE TABLE plan_adjustments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),domain TEXT NOT NULL CHECK(domain IN ('work','fitness','diet')),reason TEXT NOT NULL,requester TEXT NOT NULL,related_version INTEGER,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','handled','cancelled')),created_at TEXT NOT NULL,handled_at TEXT,handled_by TEXT);
    CREATE INDEX idx_plan_adjustments_lookup ON plan_adjustments(user_id,domain,status);
    INSERT INTO schema_migrations VALUES(10);
   `);
  }
  database.exec('COMMIT');
 }catch(e){database.exec('ROLLBACK');throw e}
}
