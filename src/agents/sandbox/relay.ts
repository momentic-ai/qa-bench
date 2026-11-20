// The container's only way out: streams to the harness over docker run's stdin and stdout.
//   relay.ts               serve the egress proxy and the driver's control channel
//   relay.ts forward PORT  serve 127.0.0.1:PORT as the host's 127.0.0.1:PORT
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { CONTROL_PORT } from "./control";
import { Mux, pipeBoth } from "./mux";
import { CONTAINER_DIRECTORY, PROXY_PORT } from "./runtime";

async function listen(
  port: number,
  onConnection: (client: net.Socket) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await writeFile(path.join(CONTAINER_DIRECTORY, `ready-${port}`), "");
}

// Opens a tunnel to the host's 127.0.0.1:<port> with the proxy's CONNECT.
function tunnel(port: number) {
  return (client: net.Socket) => {
    const upstream = net.connect(PROXY_PORT, "127.0.0.1");
    upstream.write(
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
    );
    // Reads the client until the tunnel is up, so a hangup is seen and cancels it.
    const early: Buffer[] = [];
    const hold = (chunk: Buffer) => early.push(chunk);
    const cancel = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", hold);
    client.once("end", cancel);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.off("data", onData);
      client.off("data", hold);
      client.off("end", cancel);
      if (!/^HTTP\/1\.[01] 200/.test(head.toString("latin1"))) {
        cancel();
        return;
      }
      const rest = head.subarray(end + 4);
      if (rest.length) client.write(rest);
      for (const chunk of early) upstream.write(chunk);
      pipeBoth(client, upstream);
    };
    upstream.on("data", onData);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
}

const [mode, port] = process.argv.slice(2);
if (mode === "forward") {
  await listen(Number(port), tunnel(Number(port)));
} else {
  const mux = new Mux(process.stdout, process.stdin, "container");
  // Stdin ends when the harness exits, even if it crashed.
  process.stdin.on("end", () => process.exit(0));
  await listen(CONTROL_PORT, (client) => pipeBoth(client, mux.open("control")));
  await listen(PROXY_PORT, (client) => pipeBoth(client, mux.open("proxy")));
}
