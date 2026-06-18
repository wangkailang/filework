import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 0;
};

if (process.platform !== "darwin") {
  process.exit(0);
}

const targets = [
  require.resolve("better-sqlite3/build/Release/better_sqlite3.node"),
];

for (const target of targets) {
  for (const attribute of ["com.apple.quarantine", "com.apple.provenance"]) {
    run("xattr", ["-d", attribute, target], { quiet: true });
  }

  const status = run("codesign", ["--force", "--sign", "-", target]);
  if (status !== 0) {
    throw new Error(`Failed to codesign native addon: ${target}`);
  }
}
