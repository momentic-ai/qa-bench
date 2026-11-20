import { lookup } from "node:dns/promises";
import { appendFile } from "node:fs/promises";
import net from "node:net";
import { Duplex } from "node:stream";

/** A host the sandbox may reach even when it's private: an exact name, or `*.example.com` for its subdomains. */
export type EgressRule = { host: string; port: number };

// Loopback, private, link-local (cloud metadata), shared, multicast and reserved
// ranges, plus Azure's platform address, so the sandbox can't reach the host or its network.
const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(address, prefix, "ipv6");

/**
 * A CONNECT request's destination, or a plain-HTTP request's destination and
 * the head to send it, in origin form.
 */
function proxyRequest(head: Buffer) {
  const [line, ...headers] = head.toString("latin1").split("\r\n");
  const connect = /^CONNECT ([^\s:]+|\[[^\]]+\]):(\d+) HTTP\/1\.[01]$/.exec(
    line,
  );
  if (connect) return { host: connect[1], port: Number(connect[2]) };
  const plain = /^([A-Z]+) (http:\/\/\S+) HTTP\/1\.[01]$/.exec(line);
  const url = plain && URL.parse(plain[2]);
  if (!plain || !url) return undefined;
  const forward = [
    `${plain[1]} ${url.pathname}${url.search} HTTP/1.1`,
    ...headers.filter(
      (header) =>
        !/^(host|proxy-connection|connection|keep-alive):/i.test(header),
    ),
    // The checked host, so a shared CDN address can't be asked for a blocked site.
    `Host: ${url.host}`,
    // One request per connection: a later one would reach this host whatever it names.
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return {
    host: url.hostname,
    port: Number(url.port) || 80,
    forward: Buffer.from(forward, "latin1"),
  };
}

/**
 * The sandbox's only way out: an HTTP proxy for the container's streams.
 * It tunnels to public hosts except the `blocked` domains, and to `rules` hosts.
 * Other bare IP addresses are refused, so a blocked site can't be reached by address.
 * It logs each allowed host once and every refusal.
 */
export class EgressProxy {
  private clients = new Set<Duplex>();
  private logged = new Set<string>();
  private blocked: RegExp[];

  constructor(
    private rules: EgressRule[],
    /** Domains refused with their subdomains; `*` matches any text, as in `google.*`. */
    blocked: string[],
    private logs: { allowed: string; denied: string },
  ) {
    this.blocked = blocked.map(
      (domain) =>
        new RegExp(
          `^(.*\\.)?${domain.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
        ),
    );
  }

  allow(rule: EgressRule) {
    this.rules.push(rule);
  }

  close() {
    for (const client of this.clients) client.destroy();
  }

  private ruleAllows(host: string, port: number) {
    return this.rules.some(
      (rule) =>
        rule.port === port &&
        (rule.host === host ||
          (rule.host.startsWith("*.") && host.endsWith(rule.host.slice(1)))),
    );
  }

  /** The address to connect to, or undefined to refuse. */
  private async resolve(host: string, port: number) {
    if (this.ruleAllows(host, port)) return host;
    if (net.isIP(host) || this.blocked.some((domain) => domain.test(host)))
      return undefined;
    const addresses = await lookup(host, { all: true });
    if (
      !addresses.length ||
      addresses.some(({ address, family }) =>
        PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4"),
      )
    )
      return undefined;
    // The checked address, so a second lookup can't return a private one.
    return addresses[0].address;
  }

  private log(file: string, line: string) {
    return appendFile(file, `${new Date().toISOString()} ${line}\n`);
  }

  handle(client: Duplex) {
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    let head = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16_384) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const request = proxyRequest(head.subarray(0, end));
      const host = request?.host
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .replace(/\.+$/, "");
      const port = request?.port ?? 0;
      let address: string | undefined;
      try {
        address =
          host && port > 0 && port < 65_536
            ? await this.resolve(host, port)
            : undefined;
      } catch {
        client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (client.destroyed) return;
      if (!request || !host || !address) {
        void this.log(this.logs.denied, line).catch(() => {});
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const key = `${host}:${port}`;
      if (!this.logged.has(key)) {
        this.logged.add(key);
        void this.log(this.logs.allowed, key).catch(() =>
          this.logged.delete(key),
        );
      }
      const upstream = net.connect(port, address, () => {
        if (request.forward) upstream.write(request.forward);
        else client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
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
