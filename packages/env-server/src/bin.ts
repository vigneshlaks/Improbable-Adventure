import { createInterface } from "node:readline";
import { Batch, handleLine } from "./protocol";

// Speaks the environment protocol on standard input and output: one JSON object per line each way.
const batch = new Batch();
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() !== "") process.stdout.write(`${handleLine(batch, line)}\n`);
}
