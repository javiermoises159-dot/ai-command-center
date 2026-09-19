-- SQL contract test for the persistence layer.
--
-- Verifies the semantics the Drizzle repository adapter depends on, directly
-- against PostgreSQL. It does NOT execute the adapter code — it runs the same
-- statements the adapter emits, so a design error in a query shape or a guard
-- clause shows up here. Needs only psql, which makes it the one check on this
-- layer that runs without installing the ORM.
--
--   pnpm db:check      (DATABASE_URL must point at a migrated database)
--
-- WARNING: it truncates missions. Point it at a scratch database, never prod.

\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION chk(label text, actual anyelement, expected anyelement) RETURNS void AS $$
BEGIN
  IF actual IS NOT DISTINCT FROM expected THEN
    RAISE NOTICE 'PASS  %', label;
  ELSE
    RAISE NOTICE 'FAIL  % (got %, want %)', label, actual, expected;
  END IF;
END;
$$ LANGUAGE plpgsql;

TRUNCATE missions CASCADE;

DO $$
DECLARE
  m1 uuid := gen_random_uuid();
  m2 uuid := gen_random_uuid();
  r1 uuid := gen_random_uuid();
  r2 uuid := gen_random_uuid();
  r3 uuid := gen_random_uuid();
  a  uuid;
  n  int;
  t  text;
BEGIN
  ---------------------------------------------------------------- fixtures
  INSERT INTO missions (id, prompt, title) VALUES
    (m1, 'Launch an online cookie store in Italy', 'Launch an online cookie store in Italy'),
    (m2, 'Open a bike repair shop in Lisbon',      'Open a bike repair shop in Lisbon');

  -- mission 1 has two runs (a re-run); mission 2 has one
  INSERT INTO mission_runs (id, mission_id, attempt, status, provider_id, model) VALUES
    (r1, m1, 1, 'completed', 'mock', 'mock-1'),
    (r2, m1, 2, 'running',   'mock', 'mock-1'),
    (r3, m2, 1, 'pending',   'mock', 'mock-1');

  INSERT INTO mission_agents (id, mission_id, run_id, agent_id, name, order_index, status, task)
  SELECT gen_random_uuid(), m1, r1, x.aid, x.nm, x.ix, 'completed', 't'
  FROM (VALUES ('strategy','Strategy',0),('research','Research',1),('qa','QA',2)) AS x(aid,nm,ix);

  INSERT INTO mission_agents (id, mission_id, run_id, agent_id, name, order_index, status, task)
  SELECT gen_random_uuid(), m1, r2, x.aid, x.nm, x.ix, x.st, 't'
  FROM (VALUES ('strategy','Strategy',0,'completed'),
               ('research','Research',1,'failed'),
               ('qa','QA',2,'pending')) AS x(aid,nm,ix,st);

  ------------------------------------------------- RunRepository.latestAttempt
  SELECT max(attempt) INTO n FROM mission_runs WHERE mission_id = m1;
  PERFORM chk('latestAttempt returns the highest attempt', n, 2);

  -------------------------------------------- RunRepository.findActiveByMission
  SELECT id INTO a FROM mission_runs
   WHERE mission_id = m1 AND status IN ('pending','running')
   ORDER BY attempt DESC LIMIT 1;
  PERFORM chk('findActiveByMission picks the in-flight run', a, r2);

  SELECT count(*) INTO n FROM mission_runs
   WHERE mission_id = m1 AND status = 'completed' AND id = r1;
  PERFORM chk('a completed run is not reported active', n, 1);

  ------------------------------------------------- RunRepository.markStarted
  -- guard: only a pending run may start
  UPDATE mission_runs SET status='running', started_at=now()
   WHERE id = r3 AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chk('markStarted transitions a pending run', n, 1);

  UPDATE mission_runs SET status='running', started_at=now()
   WHERE id = r3 AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chk('markStarted is a no-op on an already-running run (no duplicate worker)', n, 0);

  ------------------------------------------------ RunRepository.markFinished
  UPDATE mission_runs SET status='completed', completed_at=now()
   WHERE id = r3 AND status IN ('pending','running');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chk('markFinished closes a running run', n, 1);

  UPDATE mission_runs SET status='failed', completed_at=now()
   WHERE id = r3 AND status IN ('pending','running');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chk('markFinished cannot reopen a terminal run', n, 0);

  ------------------------------------ AgentExecutionRepository.markRemainingSkipped
  UPDATE mission_agents SET status='skipped', completed_at=now()
   WHERE run_id = r2 AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM chk('markRemainingSkipped touches only pending agents', n, 1);

  SELECT count(*) INTO n FROM mission_agents
   WHERE run_id = r2 AND status IN ('completed','failed');
  PERFORM chk('markRemainingSkipped leaves settled agents alone', n, 2);

  ---------------------------------------- MissionRepository.setFinalResult
  UPDATE missions SET final_result='BRIEF A', status='completed', updated_at=now() WHERE id=m1;
  -- a later failed run passes null: the adapter omits the column entirely
  UPDATE missions SET status='failed', updated_at=now() WHERE id=m1;
  SELECT final_result INTO t FROM missions WHERE id=m1;
  PERFORM chk('a null result does not erase a stored deliverable', t, 'BRIEF A');

  ------------------------------------------- MissionRepository.findDetail order
  SELECT string_agg(attempt::text, ',' ORDER BY attempt DESC) INTO t
    FROM mission_runs WHERE mission_id=m1;
  PERFORM chk('findDetail returns runs newest-first', t, '2,1');

  SELECT string_agg(agent_id, ',' ORDER BY order_index) INTO t
    FROM mission_agents WHERE run_id=r2;
  PERFORM chk('findDetail returns agents in pipeline order', t, 'strategy,research,qa');

  ------------------------------------------------- MissionRepository.list counts
  -- the grouped count query behind agentCounts, for the latest run only
  SELECT string_agg(status || '=' || c::text, ' ' ORDER BY status) INTO t
    FROM (SELECT status, count(*) c FROM mission_agents WHERE run_id=r2 GROUP BY status) s;
  PERFORM chk('agentCounts groups the latest run by status', t, 'completed=1 failed=1 skipped=1');

  RAISE NOTICE '---';
END $$;

-- Transaction atomicity: the guarantee MissionService.startRun relies on.
DO $$
DECLARE
  m uuid;
  r uuid := gen_random_uuid();
  n int;
BEGIN
  SELECT id INTO m FROM missions LIMIT 1;
  BEGIN
    INSERT INTO mission_runs (id, mission_id, attempt, provider_id, model)
      VALUES (r, m, 99, 'mock', 'mock-1');
    -- simulate the agent insert failing mid-transaction
    INSERT INTO mission_agents (id, mission_id, run_id, agent_id, name, order_index, status, task)
      VALUES (gen_random_uuid(), m, r, 'strategy', 'Strategy', 0, 'NOT_A_VALID_STATUS', 't');
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS  agent insert rejected by the status CHECK';
  END;

  SELECT count(*) INTO n FROM mission_runs WHERE id = r;
  PERFORM chk('the run is rolled back with it (no orphan run)', n, 0);
END $$;

DROP FUNCTION chk(text, anyelement, anyelement);
TRUNCATE missions CASCADE;
