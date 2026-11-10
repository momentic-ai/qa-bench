import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const baseUrl = `${(process.env.FIXTURE_URL || "http://metabase:3000").replace(/\/$/, "")}/api`;
const once = process.argv.includes("--once");
const email = process.env.FIXTURE_USERNAME || "eval@momentic.ai";
const password = process.env.FIXTURE_PASSWORD || "momentic-eval-1";
let session = "";

async function request(path, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "X-Metabase-Session": session } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const properties = await request("/session/properties");
if (properties["setup-token"]) {
  // Complete first-run setup before creating saved analytics content.
  await request("/setup", "POST", {
    token: properties["setup-token"],
    user: {
      first_name: "Harbor",
      last_name: "Admin",
      email,
      password,
      site_name: "Harbor Analytics",
    },
    prefs: {
      site_name: "Harbor Analytics",
      site_locale: "en",
      allow_tracking: false,
    },
  });
}
session = (await request("/session", "POST", { username: email, password })).id;
if (!session) throw new Error("Metabase login returned no session.");
const userResponse = await request("/user");
const users = userResponse.data ?? userResponse;
for (const name of ["maya", "jordan"]) {
  if (!users.some((user) => user.email === `${name}@example.test`)) {
    await request("/user", "POST", {
      email: `${name}@example.test`,
      password: "momentic-eval-1",
      first_name: name === "maya" ? "Maya" : "Jordan",
      last_name: name === "maya" ? "Chen" : "Ellis",
      send_welcome_email: false,
    });
  }
}
const databases = await request("/database");
const existing = databases.data ?? databases;
let database = existing.find((item) => item.name === "Release operations");
if (!database) {
  // Register the local dataset using a supported warehouse database.
  database = await request("/database", "POST", {
    name: "Release operations",
    engine: "postgres",
    details: {
      host: process.env.FIXTURE_DATABASE_HOST || "db",
      port: 5432,
      dbname: "release_operations",
      user: "fixture",
      password: "fixture-reader-1",
      ssl: false,
    },
    is_full_sync: true,
  });
}
const deadline = Date.now() + 240_000;
let table;
while (!table) {
  const metadata = await request(`/database/${database.id}/metadata`);
  table = metadata.tables.find(
    (item) => item.name.toLowerCase() === "release_requests",
  );
  if (!table) {
    // Metadata synchronization is asynchronous on a newly registered database.
    if (Date.now() >= deadline)
      throw new Error("Release table did not synchronize.");
    await setTimeout(2000);
  }
}
const card = await request("/card", "POST", {
  name: "Release requests",
  display: "table",
  dataset_query: {
    type: "query",
    database: database.id,
    query: { "source-table": table.id },
  },
  visualization_settings: {},
});
const tags = Object.fromEntries(
  ["region", "category"].map((name) => [
    name,
    {
      id:
        name === "region"
          ? "522c776c-b07a-40da-9f31-a0556e9414aa"
          : "5b2f9c45-7e2c-4803-87cc-e9974cf4c4d7",
      name,
      "display-name": name === "region" ? "Region" : "Category",
      type: "text",
      required: false,
    },
  ]),
);
const filteredCard = await request("/card", "POST", {
  name: "Release requests by region and category",
  display: "table",
  dataset_query: {
    type: "native",
    database: database.id,
    native: {
      query:
        "SELECT * FROM RELEASE_REQUESTS WHERE 1 = 1 [[AND REGION = {{region}}]] [[AND CATEGORY = {{category}}]] ORDER BY ID",
      "template-tags": tags,
    },
  },
  visualization_settings: {},
});
const filtered = await request(`/card/${filteredCard.id}/query`, "POST", {
  parameters: [
    {
      type: "category",
      target: ["variable", ["template-tag", "region"]],
      value: "us-east",
    },
    {
      type: "category",
      target: ["variable", ["template-tag", "category"]],
      value: "Documentation",
    },
  ],
});
if (filtered.data?.rows?.length !== 1) {
  throw new Error("Seeded native question did not apply both filters.");
}
const dashboard = await request("/dashboard", "POST", {
  name: "Release overview",
  description: "Review release requests and approval decisions.",
});
await request(`/dashboard/${dashboard.id}`, "PUT", {
  dashcards: [
    {
      id: -1,
      card_id: card.id,
      row: 0,
      col: 0,
      size_x: 18,
      size_y: 8,
      parameter_mappings: [],
    },
  ],
});
if (!once) await writeFile("/tmp/setup-complete", "ready\n");
process.stdout.write(
  "Metabase ready: local boolean data, GUI and filtered SQL questions, saved dashboard.\n",
);
if (!once) {
  // Compose keeps the setup container alive for its healthcheck.
  for (;;) await setTimeout(3_600_000);
}
