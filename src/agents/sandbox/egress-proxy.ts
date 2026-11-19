import { appendFile } from "node:fs/promises";
import net from "node:net";
import { Duplex } from "node:stream";

/** A host the sandbox may reach: an exact name, or `*.example.com` for its subdomains. */
export type EgressRule = { host: string; port: number };

/**
 * The sandbox's only way out: an HTTP CONNECT proxy for the container's streams
 * that tunnels to allowed hosts and logs every refusal.
 */
export class EgressProxy {
  private clients = new Set<Duplex>();

  constructor(
    private rules: EgressRule[],
    private deniedLog: string,
  ) {}

  allow(rule: EgressRule) {
    this.rules.push(rule);
  }

  close() {
    for (const client of this.clients) client.destroy();
  }

  private allowed(host: string, port: number) {
    return this.rules.some(
      (rule) =>
        rule.port === port &&
        (rule.host === host ||
          (rule.host.startsWith("*.") && host.endsWith(rule.host.slice(1)))),
    );
  }

  handle(client: Duplex) {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16_384) client.destroy();
        return;
      }
      client.off("data", onData);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const match = /^CONNECT ([^\s:]+|\[[^\]]+\]):(\d+) HTTP\/1\.[01]$/.exec(
        line,
      );
      const host = match?.[1].replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(match?.[2]);
      if (!host || !this.allowed(host, port)) {
        void appendFile(
          this.deniedLog,
          `${new Date().toISOString()} ${line}\n`,
        ).catch(() => {});
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = net.connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      client.on("close", () => upstream.destroy());
      for (const socket of [client, upstream]) {
        socket.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  }
}
