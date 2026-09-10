import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { hasErrorCode } from "../src/shared/validation.ts";

const exec = promisify(execFile);
test("Kitty Python renderer unit tests (optional system Python)", async (t) => {
  try {
    await exec("python3", ["-I", "test/kitty-tab-bar.test.py"], { timeout: 10000 });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      t.skip("python3 is not installed; renderer tests are available for the host");
      return;
    }
    throw error;
  }
});
