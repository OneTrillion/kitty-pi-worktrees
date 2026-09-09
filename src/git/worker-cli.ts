import { helperMain } from "./worker.ts";
console.log(await helperMain(process.argv[2] ?? ""));
