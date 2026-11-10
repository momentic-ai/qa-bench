CREATE TABLE IF NOT EXISTS RELEASE_REQUESTS (
  ID INTEGER PRIMARY KEY,
  REGION VARCHAR(32) NOT NULL,
  CATEGORY VARCHAR(32) NOT NULL,
  APPROVED BOOLEAN NOT NULL,
  AMOUNT DECIMAL(10, 2) NOT NULL,
  CREATED_AT TIMESTAMP NOT NULL
);

INSERT INTO
  RELEASE_REQUESTS
VALUES
  (
    1,
    'us-east',
    'Documentation',
    TRUE,
    120,
    CURRENT_TIMESTAMP - INTERVAL '5 days'
  ),
  (
    2,
    'us-west',
    'Infrastructure',
    FALSE,
    240,
    CURRENT_TIMESTAMP - INTERVAL '4 days'
  ),
  (
    3,
    'eu-central',
    'Documentation',
    TRUE,
    180,
    CURRENT_TIMESTAMP - INTERVAL '3 days'
  ),
  (
    4,
    'us-east',
    'Infrastructure',
    FALSE,
    360,
    CURRENT_TIMESTAMP - INTERVAL '2 days'
  ),
  (
    5,
    'us-west',
    'Documentation',
    TRUE,
    90,
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    6,
    'eu-central',
    'Infrastructure',
    FALSE,
    150,
    CURRENT_TIMESTAMP
  )
ON CONFLICT (ID) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'fixture') THEN
    CREATE ROLE fixture LOGIN PASSWORD 'fixture-reader-1';
  END IF;
END
$$;

GRANT
SELECT
  ON RELEASE_REQUESTS TO FIXTURE;
