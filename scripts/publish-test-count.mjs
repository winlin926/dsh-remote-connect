import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 徽章数据源：公开 gist 里的 test-count.json，shields 的 endpoint 直接读。
const GIST_ID = "49d5d742a7e999a6c40935ac190623e7";

const run = (command) => {
  try {
    execSync(command, { stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    console.error(`$ ${command} 失败`);
    process.exit(1);
  }
};

const dir = mkdtempSync(join(tmpdir(), "dsh-carry-badge-"));
const report = join(dir, "vitest.json");
run(`pnpm exec vitest run --reporter=json --outputFile="${report}"`);

const serverOut = execSync("npm --prefix remote-server test --silent", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).replace(/\x1b\[[0-9;]*m/g, "");
const plugin = JSON.parse(readFileSync(report, "utf8")).numPassedTests;
const server = Number(serverOut.match(/^ℹ pass (\d+)$/m)?.[1]);
const total = plugin + server;
if (!Number.isInteger(plugin) || !Number.isInteger(server) || !total) {
  console.error(`没解析出用例数：插件 ${plugin}，节点 ${server}`);
  process.exit(1);
}

const badge = { schemaVersion: 1, label: "tests", message: `${total} passing`, color: "2ea44f" };
console.log(`插件 ${plugin} + 节点 ${server} = ${total}`);

if (!process.env.GIST_TOKEN && !process.env.GH_TOKEN) {
  console.log(JSON.stringify(badge));
  process.exit(0);
}

const file = join(dir, "test-count.json");
writeFileSync(file, `${JSON.stringify(badge)}\n`);
run(`gh gist edit ${GIST_ID} -f test-count.json "${file}"`);
console.log("gist 已更新");