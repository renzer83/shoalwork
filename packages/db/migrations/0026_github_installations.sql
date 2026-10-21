-- GitHub App installations (T-084). One row per installation of the App; `repos` is a JSON array of
-- "owner/name" the installation covers. Written by installation webhooks; read to find the token of a repo.
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id integer PRIMARY KEY,
  account text NOT NULL,
  repos text NOT NULL DEFAULT '[]' /* JSON array */
);
