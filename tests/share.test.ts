import { describe, expect, it } from "vitest";
import { newCode, pack, peerIdOf, readCode, showCode, unpack } from "../src/share/share";

describe("share project", () => {
  it("makes six-digit codes, shows them in two threes and reads what was typed", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^[1-9]\d{5}$/);
    expect(showCode("123456")).toBe("123 456");
    expect(readCode(" 123 456 ")).toBe("123456");
    expect(readCode("123-456")).toBe("123456");
    expect(readCode("12345")).toBeNull();
    expect(readCode("1234567")).toBeNull();
    expect(peerIdOf("123456")).toBe("cocaide-share-v1-123456");
  });
  it("packs a project small (deflated) and unpacks it whole", async () => {
    const text = JSON.stringify({ version: 1, units: "mm", name: "house", features: Array.from({ length: 400 }, (_, i) => ({ id: `box_${i}`, op: "extrude", sketch: `box_${i}_sk`, distance: 750 })) });
    const p = await pack("house", text);
    expect(p.data.byteLength).toBeLessThan(text.length / 5);
    expect(await unpack(p)).toEqual({ name: "house", text });
    // As the other browser's data channel may hand it over: a typed array.
    expect(await unpack({ ...p, data: new Uint8Array(p.data) })).toEqual({ name: "house", text });
  });
  it("says what is wrong with what arrived", async () => {
    expect(await unpack(null)).toEqual({ error: "what arrived is not a Cocaide project" });
    expect(await unpack({ kind: "something", data: new ArrayBuffer(4) })).toEqual({ error: "what arrived is not a Cocaide project" });
    expect(await unpack({ kind: "cocaide-project", name: "x", data: new Uint8Array([1, 2, 3, 4]).buffer, length: 4 })).toEqual({ error: "the project arrived damaged: try again" });
    const p = await pack("x", "hello");
    expect(await unpack({ ...p, length: 99 })).toEqual({ error: "the project arrived incomplete: try again" });
  });
});
