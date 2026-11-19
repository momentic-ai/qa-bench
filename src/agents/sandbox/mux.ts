import { Duplex, Readable, Writable } from "node:stream";

const OPEN = 0;
const DATA = 1;
const END = 2;
const RESET = 3;
const HEADER = 9;

/**
 * Named byte streams over one pipe pair, such as `docker run -i`'s stdin and
 * stdout. Each frame is a type, a stream id and a length-prefixed payload.
 */
export class Mux {
  private streams = new Map<number, Duplex>();
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
    input.on("close", () => {
      for (const stream of this.streams.values()) stream.destroy();
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
    const stream: Duplex = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, done) => {
        if (this.send(DATA, id, chunk)) done();
        else this.output.once("drain", () => done());
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
    this.streams.set(id, stream);
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
      const stream = this.streams.get(id);
      if (!stream) continue;
      if (type === DATA) stream.push(payload);
      else if (type === END) stream.push(null);
      else {
        this.streams.delete(id);
        stream.destroy();
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
