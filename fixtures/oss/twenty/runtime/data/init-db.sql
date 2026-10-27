-- Match Twenty's database bootstrap before running its production migrations.
CREATE SCHEMA IF NOT EXISTS public;

CREATE SCHEMA IF NOT EXISTS metadata;

CREATE SCHEMA IF NOT EXISTS core;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
