import { Duplex, Readable, Writable } from "node:stream";

const OPEN = 0;
const DATA = 1;
const END = 2;
const RESET = 3;
const CREDIT = 4;
const HEADER = 9;
// Bytes a stream may send that its reader hasn't consumed yet.
const WINDOW = 1 << 20;

type Channel = {
  stream: Duplex;
  receive(data: Buffer): void;
  grant(bytes: number): void;
};

/**
 * Named byte streams over one pipe pair, such as `docker run -i`'s stdin and
 * stdout. Each frame is a type, a stream id and a length-prefixed payload.
 * Each side returns credit as its reader consumes data, so a slow reader
 * stalls only its own stream's sender.
 */
export class Mux {
  private streams = new Map<number, Channel>();
  private pending = Buffer.alloc(0);
  private nextId: number;

  constructor(
    private output: Writable,
    input: Readable,
    side: "host" | "container",
    private onStream: (name: string, stream: Duplex) => void = (_, stream) =>
      stream.destroy(),
  ) {
    // Odd ids for streams the host opens, even for the container's.
    this.nextId = side === "host" ? 1 : 2;
    output.on("error", () => {});
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    for (const end of [input, output])
      end.on("close", () => {
        for (const { stream } of this.streams.values()) stream.destroy();
      });
  }

  open(name: string) {
    const id = this.nextId;
    this.nextId += 2;
    const stream = this.stream(id);
    this.send(OPEN, id, Buffer.from(name));
    return stream;
  }

  private stream(id: number) {
    let credit = WINDOW;
    let owed = 0;
    let blocked: (() => void) | undefined;
    const stream: Duplex = new Duplex({
      // Node calls this when the reader wants more data.
      read: () => {
        if (owed < WINDOW / 2) return;
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(owed);
        owed = 0;
        this.send(CREDIT, id, bytes);
      },
      write: (chunk: Buffer, _encoding, done) => {
        const send = () => {
          credit -= chunk.length;
          if (this.send(DATA, id, chunk)) done();
          else this.output.once("drain", () => done());
        };
        if (credit > 0) send();
        else blocked = send;
      },
      final: (done) => {
        this.send(END, id);
        done();
      },
      destroy: (err, done) => {
        // Streams that ended both ways need no reset; the other side's ends too.
        if (
          this.streams.delete(id) &&
          !(stream.readableEnded && stream.writableFinished)
        )
          this.send(RESET, id);
        done(err);
      },
    });
    this.streams.set(id, {
      stream,
      receive: (data) => {
        owed += data.length;
        stream.push(data);
      },
      grant: (bytes) => {
        credit += bytes;
        if (credit <= 0 || !blocked) return;
        const send = blocked;
        blocked = undefined;
        send();
      },
    });
    return stream;
  }

  private send(type: number, id: number, payload: Buffer = Buffer.alloc(0)) {
    const header = Buffer.alloc(HEADER);
    header[0] = type;
    header.writeUInt32BE(id, 1);
    header.writeUInt32BE(payload.length, 5);
    return this.output.write(Buffer.concat([header, payload]));
  }

  private receive(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= HEADER) {
      const length = this.pending.readUInt32BE(5);
      if (this.pending.length < HEADER + length) return;
      const type = this.pending[0];
      const id = this.pending.readUInt32BE(1);
      const payload = this.pending.subarray(HEADER, HEADER + length);
      this.pending = this.pending.subarray(HEADER + length);
      if (type === OPEN) {
        this.onStream(payload.toString(), this.stream(id));
        continue;
      }
      const channel = this.streams.get(id);
      if (!channel) continue;
      if (type === DATA) channel.receive(payload);
      else if (type === CREDIT) {
        if (length === 4) channel.grant(payload.readUInt32BE(0));
      } else if (type === END) channel.stream.push(null);
      else {
        this.streams.delete(id);
        channel.stream.destroy();
      }
    }
  }
}

/** Pipes both ways, and tears both down when either is cut off rather than ended. */
export function pipeBoth(a: Duplex, b: Duplex) {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ]) {
    from.on("error", () => to.destroy());
    from.on("close", () => {
      if (!from.readableEnded || !from.writableFinished) to.destroy();
    });
  }
  a.pipe(b).pipe(a);
}
