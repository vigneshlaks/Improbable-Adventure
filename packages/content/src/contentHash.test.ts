import { describe, expect, it } from "vitest";
import balanceJson from "../balance.json";
import { canonicalJson, contentHash, hashContent } from "./contentHash";

describe("contentHash", () => {
  it("is the same for the same content in any key order, changes with any value or file, and is a fixed-length hex string", () => {
    expect(canonicalJson({ b: [1, { z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[1,{"a":2,"z":1}]}');
    const files = { balance: { BASE: 20, TIERS: { minion: { hp: 20 } } }, fusions: { hyperLogLog: { inputs: ["logLog", "linearCounting"] } } };
    const hash = hashContent(files);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashContent({ fusions: files.fusions, balance: { TIERS: { minion: { hp: 20 } }, BASE: 20 } })).toBe(hash); // key order does not matter
    expect(hashContent({ ...files, balance: { ...files.balance, BASE: 21 } })).not.toBe(hash);
    expect(hashContent({ ...files, balance: { BASE: 20, TIERS: { minion: { hp: 21 } } } })).not.toBe(hash);
    expect(hashContent({ ...files, fusions: {} })).not.toBe(hash);
    expect(hashContent({ other: files.balance, fusions: files.fusions })).not.toBe(hash); // the file's name counts too

    // The real content: stable from call to call, and it moves when the balance does.
    expect(contentHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash()).toBe(contentHash());
    expect(contentHash({ balance: { ...balanceJson, BASE: balanceJson.BASE + 1 } })).not.toBe(contentHash());
    // The exporter's settings are not rules: a recorded run stays valid when they change.
    const rules = Object.fromEntries(Object.entries(balanceJson).filter(([key]) => !key.startsWith("EXPORT_") && !key.startsWith("RL_")));
    expect(contentHash({ balance: rules })).toBe(contentHash());
  });
});
