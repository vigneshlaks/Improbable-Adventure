import { readFileSync, writeFileSync } from "node:fs";
import { main } from "./cli";

const { code, output, files } = main(process.argv.slice(2), { readText: (path) => readFileSync(path, "utf8") });
for (const file of files ?? []) writeFileSync(file.path, file.content);
console.log(output);
process.exitCode = code;
