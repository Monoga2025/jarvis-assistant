import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "jarvis-tools");
const temporary = await mkdtemp(path.join(tmpdir(), "jarvis-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable.");
const runNpm = (arguments_: string[], options: { cwd: string; stdio?: "ignore" }): string =>
  execFileSync(process.execPath, [npmCli, ...arguments_], {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });

try {
  const packOutput = runNpm(["pack", plugin, "--pack-destination", temporary, "--json"], { cwd: root });
  const packed = JSON.parse(packOutput) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const artifact = packed[0];
  if (!artifact) throw new Error("npm pack did not produce an artifact.");
  const paths = artifact.files.map((file) => file.path);
  const requiredRuntimeFiles = [
    "dist/index.js",
    "dist/legacy-seed.js",
    "dist/reminder-worker.js",
    "dist/calendar-readiness.js",
    "dist/schedule-import.js",
    "openclaw.plugin.json",
  ];
  if (paths.some((file) => file.startsWith("src/")) || requiredRuntimeFiles.some((file) => !paths.includes(file))) {
    throw new Error("Production package contains source or is missing runtime files.");
  }

  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@jarvis-v1/openclaw-tools": `file:${path.join(temporary, artifact.filename)}`,
      openclaw: "2026.9.1",
    },
  }));
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, stdio: "ignore" });
  const installedPackage = JSON.parse(await readFile(path.join(consumer, "node_modules", "@jarvis-v1", "openclaw-tools", "package.json"), "utf8")) as {
    openclaw?: { extensions?: string[] };
  };
  if (installedPackage.openclaw?.extensions?.[0] !== "./dist/index.js") {
    throw new Error("Installed package does not point at its built extension.");
  }
  await import(pathToFileURL(path.join(consumer, "node_modules", "@jarvis-v1", "openclaw-tools", "dist", "index.js")).href);
  process.stdout.write("PACKAGE_OK clean installed artifact imported at runtime.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
