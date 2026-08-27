// #1899 — execute the version gate embedded in each authoritative workflow against both
// a coherent release and the stale rendered changelog that previously shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = [
  join(ROOT, ".github", "workflows", "ci.yml"),
  join(ROOT, ".github", "workflows", "publish_action.yml"),
];
const VERSION = "1.2.3";

function versionGate(workflowPath) {
  const workflow = readFileSync(workflowPath, "utf8");
  const start = workflow.indexOf("- name: pyproject.toml is valid + has registry fields + JS version matches");
  assert.notEqual(start, -1, `${workflowPath}: version gate step is missing`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, end === -1 ? workflow.length : end);
  const match = /python - <<'PY'\r?\n([\s\S]*?)\r?\n\s*PY/.exec(step);
  assert.ok(match, `${workflowPath}: could not extract the production Python gate`);
  // YAML removes the ten-space block indentation before the runner executes this heredoc.
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function runGate(workflowPath, renderedVersion) {
  const cwd = mkdtempSync(join(tmpdir(), "panel-release-version-gate-"));
  try {
    mkdirSync(join(cwd, "web", "js"), { recursive: true });
    writeFileSync(
      join(cwd, "pyproject.toml"),
      `[project]\nname = "comfyui-agent-panel"\nversion = "${VERSION}"\ndescription = "fixture"\nlicense = { file = "LICENSE" }\n\n[tool.comfy]\nPublisherId = "artokun"\n`,
    );
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: VERSION }));
    writeFileSync(join(cwd, "LICENSE"), "fixture\n");
    writeFileSync(join(cwd, "web", "changelog.json"), JSON.stringify({ releases: [{ version: renderedVersion }] }));
    writeFileSync(join(cwd, "web", "js", "comfyui-mcp-panel.js"), `const PANEL_VERSION = "${VERSION}";\n`);
    const result = spawnSync("python", ["-c", versionGate(workflowPath)], {
      cwd,
      encoding: "utf8",
    });
    return result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const workflowPath of WORKFLOWS) {
  test(`${workflowPath}: matching rendered changelog passes the actual version gate`, () => {
    const result = runGate(workflowPath, VERSION);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /all four release version witnesses match/);
  });

  test(`${workflowPath}: stale rendered changelog fails and names the artefact`, () => {
    const result = runGate(workflowPath, "1.2.2");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /VERSION MISMATCH/);
    assert.match(result.stderr, /web\/changelog\.json=1\.2\.2/);
  });
}
