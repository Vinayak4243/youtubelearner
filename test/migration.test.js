const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('learner snapshot, user rate limit, RLS policies and rate limit function are declared', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '202610020001_adaptpractice.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.learner_snapshots/i);
  assert.match(migration, /create table if not exists public\.user_rate_limits/i);
  assert.match(migration, /alter table public\.%I enable row level security/i);
  assert.match(migration, /create policy owner_access[\s\S]+auth\.uid\(\)\s*=\s*user_id/i);
  assert.match(migration, /create or replace function public\.consume_user_ai_rate_limit/i);
  assert.match(migration, /grant execute on function public\.consume_user_ai_rate_limit\(integer\) to authenticated/i);
});
