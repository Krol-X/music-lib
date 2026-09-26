import { inspectPath, serviceTags } from "./inspect";

const path = process.argv[2];
if (!path) throw new Error("usage: bun run examples/inspect-demo.ts <file>");

const meta = await inspectPath(path);

console.log("=== format ===");
console.log(meta.format);

console.log("\n=== common ===");
console.log({ ...meta.common, picture: undefined });

console.log("\ncover:", meta.cover);

console.log("\n=== native ===");
console.dir(meta.native, { depth: null });

console.log("\n=== MUSICLIB_* ===");
console.log(serviceTags(meta));

console.log("\n=== warnings ===");
console.log(meta.warnings);
