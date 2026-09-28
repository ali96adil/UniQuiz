import assert from "node:assert/strict";
import test from "node:test";
import { encodeOscMessage, OscOutput } from "./osc-output.js";

function readOscString(
  buffer: Buffer,
  offset: number,
): { value: string; next: number } {
  const zero = buffer.indexOf(0, offset);
  assert.notEqual(zero, -1);
  const value = buffer.subarray(offset, zero).toString("utf8");
  const consumed = zero - offset + 1;
  const padded = Math.ceil(consumed / 4) * 4;
  return { value, next: offset + padded };
}

test("encodes OSC address, type tags, integers and strings", () => {
  const encoded = encodeOscMessage(
    "/uniquiz/question/countdown",
    [4, 2, 3, "test"],
  );

  const address = readOscString(encoded, 0);
  assert.equal(address.value, "/uniquiz/question/countdown");

  const tags = readOscString(encoded, address.next);
  assert.equal(tags.value, ",iiis");

  assert.equal(encoded.readInt32BE(tags.next), 4);
  assert.equal(encoded.readInt32BE(tags.next + 4), 2);
  assert.equal(encoded.readInt32BE(tags.next + 8), 3);

  const stringArg = readOscString(encoded, tags.next + 12);
  assert.equal(stringArg.value, "test");
});

test("disabled OSC output is a no-op", () => {
  const output = new OscOutput({
    enabled: false,
    host: "127.0.0.1",
    port: 9001,
  });

  assert.doesNotThrow(() => {
    output.send("/uniquiz/question/start", [1, 1, 45000]);
  });
});

test("OSC encoder rejects invalid addresses", () => {
  assert.throws(
    () => encodeOscMessage("uniquiz/question/start"),
    /start with/,
  );
});
