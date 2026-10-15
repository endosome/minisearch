// Builds the profiling package, target/pkg-stats: the same sources as pkg/,
// with the engine's counters, phase timers and allocator accounting (Cargo
// feature `stats`, src/stats.rs) and their two static methods,
// `MiniSearchWasm.engineStats()` and `resetEngineStats()`. Never published:
// timings from it are for comparing phases, not for quoting. The profiling
// runner (differential/profile.mjs) loads it.
//
// A target directory of its own keeps the release build cached.
//
//   node scripts/build-stats.mjs

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });

// A shell finds wasm-pack's launcher on Windows too.
run("wasm-pack", ["build", "--target", "web", "--release", "--no-pack", "--out-dir", "target/wasm-glue-stats", "--", "--features", "stats"],
  { shell: process.platform === "win32", env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target/stats") } });
run(process.execPath, [resolve(root, "scripts/finalize-pkg.mjs"), "--glue", "target/wasm-glue-stats", "--out", "target/pkg-stats"]);
