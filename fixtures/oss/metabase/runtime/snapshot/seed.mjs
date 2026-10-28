const baseUrl = `${process.env.FIXTURE_URL}/api`;
let session;
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
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
const properties = await request("/session/properties");
await request("/setup", "POST", {
  token: properties["setup-token"],
  user: {
    first_name: "Eval",
    last_name: "Admin",
    email: process.env.FIXTURE_USERNAME,
    password: process.env.FIXTURE_PASSWORD,
    site_name: "Analytics",
  },
  prefs: { site_name: "Analytics", site_locale: "en", allow_tracking: false },
});
session = (
  await request("/session", "POST", {
    username: process.env.FIXTURE_USERNAME,
    password: process.env.FIXTURE_PASSWORD,
  })
).id;
if (!session) throw new Error("Metabase login returned no session.");
process.stdout.write(
  "Metabase installed with one account and its normal defaults.\n",
);
