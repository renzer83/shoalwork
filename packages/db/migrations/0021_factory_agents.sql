-- Dev Factory agents (T-058 debt): the SOULs the bridge export carries, upserted by (source, name) so a
-- re-import converges like projects and tasks. Still just the catalog row; T-059 templates read it later.
CREATE TABLE IF NOT EXISTS factory_agents (
  name text NOT NULL,
  role text NOT NULL,
  model text,
  instructions_path text,
  source text NOT NULL,
  PRIMARY KEY (source, name)
);
