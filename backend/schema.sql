CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,status TEXT NOT NULL,title TEXT NOT NULL,proposal_json TEXT NOT NULL,source TEXT,note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_requests_status_created ON requests(status,created_at);
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT NOT NULL,ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket_ts ON rate_limits(bucket,ts);
