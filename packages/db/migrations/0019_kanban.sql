-- Kanban por projeto (T-060): a máquina de estados vive nos eventos `project_task.state_changed` e
-- `project_tasks` é a projeção. `max_in_progress` limita quantas tasks do projeto correm ao mesmo tempo
-- (paralelismo em vez de uma por vez). `branch` é o head do PR, usado para casar a CI com a task.
ALTER TABLE projects ADD COLUMN max_in_progress integer NOT NULL DEFAULT 3;
ALTER TABLE project_tasks ADD COLUMN branch text;
ALTER TABLE project_tasks ADD COLUMN updated_at text;
ALTER TABLE project_tasks ADD COLUMN version integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS project_tasks_issue_idx ON project_tasks (project, issue_number) WHERE issue_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_tasks_state_idx ON project_tasks (project, state);
-- A chave de idempotência do sync: a mesma delivery do GitHub não cria duas tasks nem duas transições.
CREATE TABLE IF NOT EXISTS kanban_deliveries (
  project text NOT NULL,
  delivery_id text NOT NULL,
  kind text NOT NULL,
  applied_at text NOT NULL,
  position integer,
  PRIMARY KEY (project, delivery_id)
);
