import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 徽章数据源：公开 gist 里的 test-count.json，shields 的 endpoint 读取它。
// GIST_ID 为空时只打印计数，方便本地看。
const GIST_ID = "49d5d742a7e999a6c40935ac190623e7";

const run = (command) => {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    console.error(`$ ${command} 失败`);
    process.exit(1);
  }
};

const pluginOut = run("pnpm test");
const serverOut = run("npm --prefix remote-server test --silent");

const plugin = Number(pluginOut.match(/Tests\s+(\d+) passed/)?.[1]);
const server = Number(serverOut.match(/ℹ pass (\d+)/)?.[1]);
if (!plugin || !server) {
  console.error("没解析出用例数：插件 %s，节点 %s", plugin, server);
  process.exit(1);
}

const total = plugin + server;
const badge = { schemaVersion: 1, label: "tests", message: `${total} passing`, color: "2ea44f" };
console.log(`插件 ${plugin} + 节点 ${server} = ${total}`);

if (!GIST_ID) {
  console.log(JSON.stringify(badge));
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "dsh-carry-badge-"));
const file = join(dir, "test-count.json");
writeFileSync(file, `${JSON.stringify(badge)}\n`);
run(`gh gist edit ${GIST_ID} -f test-count.json "${file}"`);
console.log("gist 已更新");