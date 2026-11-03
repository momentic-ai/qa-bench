import { stdin, stdout } from "node:process";

let input = "";
for await (const chunk of stdin) input += chunk;
const request = JSON.parse(input);
if (
  request.protocol !== "agent-browser.plugin.v1" ||
  request.type !== "browser.launch"
) {
  throw new Error("Unsupported browser provider request.");
}
const response = await fetch(
  new URL("json/version/", process.env.QA_BENCH_CDP_ENDPOINT),
  {
    signal: AbortSignal.timeout(10000),
  },
);
if (!response.ok) throw new Error("Browserbase allocation failed.");
const connection = await response.json();
if (typeof connection.webSocketDebuggerUrl !== "string")
  throw new Error("Missing browser connection.");
stdout.write(
  JSON.stringify({
    protocol: "agent-browser.plugin.v1",
    success: true,
    browser: { cdpUrl: connection.webSocketDebuggerUrl },
  }),
);
