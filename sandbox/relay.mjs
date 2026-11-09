// Runs inside the sandbox container, which has no network. Everything leaves
// through one Unix socket to the harness's egress proxy on the host.
//
//   relay.mjs keep          Serve the proxy on 127.0.0.1:3128 until the host's
//                           proxy goes away, then exit so the container stops.
//   relay.mjs forward PORT  Serve 127.0.0.1:PORT as the host's 127.0.0.1:PORT.
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DIRECTORY = "/run/qa-bench";
const SOCKET = `${DIRECTORY}/egress.sock`;
const PROXY_PORT = 3128;

function pipeBoth(a, b) {
  for (const socket of [a, b]) {
    socket.on("error", () => {
      a.destroy();
      b.destroy();
    });
  }
  a.pipe(b).pipe(a);
}

async function listen(port, onConnection) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await writeFile(`${DIRECTORY}/ready-${port}`, "");
}

// Opens a tunnel to the host's 127.0.0.1:<port> with the proxy's CONNECT.
function tunnel(port) {
  return (client) => {
    client.pause();
    const upstream = net.connect(SOCKET);
    upstream.write(
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(head.toString("latin1"))) {
        client.destroy();
        upstream.destroy();
        return;
      }
      const rest = head.subarray(end + 4);
      if (rest.length) client.write(rest);
      pipeBoth(client, upstream);
      client.resume();
    };
    upstream.on("data", onData);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
}

function reachable() {
  return new Promise((resolve) => {
    const socket = net.connect(SOCKET, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

const [mode, port] = process.argv.slice(2);
if (mode === "forward") {
  await listen(Number(port), tunnel(Number(port)));
} else if (mode === "keep") {
  await listen(PROXY_PORT, (client) => pipeBoth(client, net.connect(SOCKET)));
  // A harness that crashed leaves no proxy behind, so the container stops itself.
  for (let failures = 0; failures < 3; ) {
    await delay(5_000);
    failures = (await reachable()) ? 0 : failures + 1;
  }
  process.exit(0);
} else {
  process.stderr.write("Usage: relay.mjs keep | forward PORT\n");
  process.exit(2);
}
