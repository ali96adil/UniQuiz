import dgram from "node:dgram";

export type OscArgument = string | number;

export interface ShowControlOutput {
  send(address: string, args?: readonly OscArgument[]): void;
}

export interface OscOutputConfig {
  enabled: boolean;
  host: string;
  port: number;
}

function paddedOscString(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const required = raw.length + 1;
  const paddedLength = Math.ceil(required / 4) * 4;
  const output = Buffer.alloc(paddedLength);
  raw.copy(output);
  return output;
}

function int32(value: number): Buffer {
  if (!Number.isInteger(value)) {
    throw new Error("OSC integer arguments must be integers.");
  }

  const output = Buffer.alloc(4);
  output.writeInt32BE(value, 0);
  return output;
}

export function encodeOscMessage(
  address: string,
  args: readonly OscArgument[] = [],
): Buffer {
  if (!address.startsWith("/")) {
    throw new Error("OSC address must start with '/'.");
  }

  const typeTags =
    "," +
    args
      .map((argument) => (typeof argument === "number" ? "i" : "s"))
      .join("");

  const payload = args.map((argument) =>
    typeof argument === "number"
      ? int32(argument)
      : paddedOscString(argument),
  );

  return Buffer.concat([
    paddedOscString(address),
    paddedOscString(typeTags),
    ...payload,
  ]);
}

export class OscOutput implements ShowControlOutput {
  constructor(
    private readonly config: OscOutputConfig,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  send(
    address: string,
    args: readonly OscArgument[] = [],
  ): void {
    if (!this.config.enabled) return;

    let message: Buffer;
    try {
      message = encodeOscMessage(address, args);
    } catch (error) {
      this.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    const socket = dgram.createSocket("udp4");
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      socket.close();
    };

    socket.once("error", (error) => {
      this.onError(error);
      close();
    });

    try {
      socket.send(
        message,
        this.config.port,
        this.config.host,
        (error) => {
          if (error) this.onError(error);
          close();
        },
      );
    } catch (error) {
      this.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
      close();
    }
  }
}

export const NOOP_SHOW_CONTROL: ShowControlOutput = {
  send() {},
};
