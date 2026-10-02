create extension if not exists pgcrypto;

create table if not exists public.student_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  present_state jsonb not null default '{}'::jsonb,
  future_state jsonb not null default '{}'::jsonb,
  behaviour jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.courses (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  goal jsonb not null default '{}'::jsonb,
  current_state jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.course_sources (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  source_type text not null check (source_type in ('youtube_video','youtube_playlist','pdf','text')),
  title text not null default '',
  url text,
  status text not null default 'pending' check (status in ('pending','processing','ready','partial','failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade
);

create table if not exists public.source_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null,
  ordinal integer not null check (ordinal >= 0),
  page_number integer check (page_number is null or page_number > 0),
  start_seconds numeric check (start_seconds is null or start_seconds >= 0),
  end_seconds numeric check (end_seconds is null or end_seconds >= start_seconds),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, source_id, ordinal),
  foreign key (user_id, source_id) references public.course_sources(user_id, id) on delete cascade
);

create table if not exists public.concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  name text not null,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, course_id, name),
  unique (user_id, id),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade
);

create table if not exists public.assignments (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  title text not null default '',
  mode text not null default 'practice',
  source_id text,
  status text not null default 'open' check (status in ('open','submitted','graded','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  primary key (user_id, id),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, source_id) references public.course_sources(user_id, id) on delete cascade
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  assignment_id text not null,
  answers jsonb not null default '[]'::jsonb,
  results jsonb not null default '[]'::jsonb,
  score numeric,
  report text,
  submitted_at timestamptz not null default now(),
  foreign key (user_id, assignment_id) references public.assignments(user_id, id) on delete cascade
);

create table if not exists public.mistakes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  assignment_id text not null,
  concept_id uuid,
  kind text not null default 'unclassified',
  confidence text not null default 'low' check (confidence in ('low','medium','high')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, assignment_id) references public.assignments(user_id, id) on delete cascade,
  foreign key (user_id, concept_id) references public.concepts(user_id, id) on delete cascade
);

create table if not exists public.revision_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  concept_id uuid,
  source_id text,
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, concept_id) references public.concepts(user_id, id) on delete cascade,
  foreign key (user_id, source_id) references public.course_sources(user_id, id) on delete cascade
);

create table if not exists public.confusion_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  source_id text not null,
  concept_id uuid,
  timestamp_seconds numeric check (timestamp_seconds is null or timestamp_seconds >= 0),
  explanation_mode text not null default 'simple',
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, source_id) references public.course_sources(user_id, id) on delete cascade,
  foreign key (user_id, concept_id) references public.concepts(user_id, id) on delete cascade
);

create table if not exists public.mastery_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  concept_id uuid not null,
  mastery numeric not null check (mastery >= 0 and mastery <= 100),
  confidence text not null default 'low' check (confidence in ('low','medium','high')),
  evidence jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, concept_id) references public.concepts(user_id, id) on delete cascade
);

create table if not exists public.roadmaps (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade
);

create table if not exists public.learning_events (
  id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text,
  source_id text,
  assignment_id text,
  event_type text not null,
  event_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  primary key (user_id, id),
  foreign key (user_id, course_id) references public.courses(user_id, id) on delete cascade,
  foreign key (user_id, source_id) references public.course_sources(user_id, id) on delete cascade,
  foreign key (user_id, assignment_id) references public.assignments(user_id, id) on delete cascade
);

create table if not exists public.learner_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, window_start)
);

create index if not exists courses_user_updated_idx on public.courses(user_id, updated_at desc);
create index if not exists sources_course_idx on public.course_sources(user_id, course_id, created_at);
create index if not exists segments_source_page_idx on public.source_segments(user_id, source_id, page_number, start_seconds);
create index if not exists segments_content_fts_idx on public.source_segments using gin (to_tsvector('simple', content));
create index if not exists assignments_course_created_idx on public.assignments(user_id, course_id, created_at desc);
create index if not exists submissions_assignment_idx on public.submissions(user_id, assignment_id, submitted_at desc);
create index if not exists mistakes_concept_idx on public.mistakes(user_id, course_id, concept_id, created_at desc);
create index if not exists revisions_queue_idx on public.revision_records(user_id, course_id, completed_at, created_at);
create index if not exists confusion_source_time_idx on public.confusion_events(user_id, source_id, timestamp_seconds);
create index if not exists mastery_course_concept_idx on public.mastery_records(user_id, course_id, concept_id, recorded_at desc);
create index if not exists learning_events_timeline_idx on public.learning_events(user_id, course_id, event_at desc);
create index if not exists learner_snapshots_payload_idx on public.learner_snapshots using gin (payload jsonb_path_ops);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'student_profiles', 'courses', 'course_sources', 'source_segments', 'concepts',
    'assignments', 'submissions', 'mistakes', 'revision_records', 'confusion_events',
    'mastery_records', 'roadmaps', 'learning_events', 'learner_snapshots', 'user_rate_limits'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS owner_access ON public.%I', table_name);
    EXECUTE format('CREATE POLICY owner_access ON public.%I FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)', table_name);
  END LOOP;
END $$;

create or replace function public.consume_user_ai_rate_limit(max_requests integer default 20)
returns boolean
language plpgsql
as $$
DECLARE
  current_user_id uuid := auth.uid();
  current_window timestamptz := date_trunc('minute', now());
  updated_count integer;
BEGIN
  IF current_user_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.user_rate_limits (user_id, window_start, request_count)
  VALUES (current_user_id, current_window, 1)
  ON CONFLICT (user_id, window_start)
  DO UPDATE SET request_count = public.user_rate_limits.request_count + 1
  RETURNING request_count INTO updated_count;
  RETURN updated_count <= greatest(1, least(max_requests, 60));
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_user_ai_rate_limit(integer) TO authenticated;
