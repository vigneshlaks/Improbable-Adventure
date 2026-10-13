import { main } from "./cli";

const { code, output } = main(process.argv.slice(2));
console.log(output);
process.exitCode = code;
