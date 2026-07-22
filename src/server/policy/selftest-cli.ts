import { runSelfTest } from "./selftest.js";

const result = await runSelfTest();
console.log(`SDK ${result.sdkVersion}: self-test ${result.status}`);
console.log(result.detail);
process.exit(result.status === "passed" ? 0 : 1);
