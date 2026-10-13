-- T004の試験専用の対象表。本番migrationには含めない（drizzle/ ではなく tests/ に置く）。
CREATE TABLE IF NOT EXISTS t_issues (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id),
  status TEXT NOT NULL CHECK (status IN ('reported', 'under_review', 'in_progress', 'resolved', 'closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT
);
CREATE TABLE IF NOT EXISTS t_issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES t_issues (id),
  unit_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL CHECK (to_status IN ('reported', 'under_review', 'in_progress', 'resolved', 'closed'))
);
