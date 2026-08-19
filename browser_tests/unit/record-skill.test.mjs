// #350 — /record-skill snapshots the open graph as a reusable SKILL.md.
//
// Tests drive the shipped functions on the real path: a LiteGraph-shaped graph
// goes through recordSkillFromGraph, and persistRecordedSkill is the write.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  skillSlug,
  skillNameFromSlash,
  recordedSkillUserdataPath,
  recordSkillFromGraph,
  persistRecordedSkill,
  SKILL_WIDGET_VALUE_CAP,
} from "../../web/js/lib/record-skill.js";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"), "utf8");

function sampleGraph({ prompt, steps } = {}) {
  return {
    _nodes: [
      {
        id: 11,
        type: "CLIPTextEncode",
        title: "Positive",
        widgets: [{ name: "text", value: prompt }],
        inputs: [],
        outputs: [{ links: [3] }],
      },
      {
        id: 22,
        type: "KSampler",
        widgets: [{ name: "steps", value: steps }],
        inputs: [{ name: "model", link: 3 }],
        outputs: [],
      },
    ],
    links: {
      3: { origin_id: 11, origin_slot: 0, target_id: 22, target_slot: 0, type: "CONDITIONING" },
    },
  };
}

test("recordSkillFromGraph refuses an empty canvas instead of writing a skill", () => {
  const recorded = recordSkillFromGraph({ _nodes: [] }, { title: "Empty" });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.reason, "empty");
  assert.equal(recorded.markdown, undefined);
});

test("recordSkillFromGraph refuses a missing graph", () => {
  const recorded = recordSkillFromGraph(null, { title: "Gone" });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.reason, "no_graph");
});

test("recordSkillFromGraph writes the live graph's types, widgets and links into the skill", () => {
  const prompt = "a watercolor fox";
  const steps = 28;
  const title = "Fox watercolor";
  const graph = sampleGraph({ prompt, steps });
  const recorded = recordSkillFromGraph(graph, { title });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.nodeCount, graph._nodes.length);
  assert.equal(recorded.slug, skillSlug(title));
  assert.equal(recorded.path, recordedSkillUserdataPath(recorded.slug));
  for (const n of graph._nodes) {
    assert.match(recorded.markdown, new RegExp(String(n.id)));
    assert.match(recorded.markdown, new RegExp(n.type));
  }
  assert.match(recorded.markdown, new RegExp(prompt));
  assert.match(recorded.markdown, new RegExp(String(steps)));
  assert.match(recorded.markdown, /#11\.0 → #22\.0/);
  assert.match(recorded.markdown, /CONDITIONING/);
  assert.match(recorded.markdown, /panel_add_node/);
  assert.match(recorded.markdown, /panel_set_widget/);
  assert.match(recorded.markdown, /panel_connect/);
  assert.match(recorded.markdown, /panel_graph_outline/);
  assert.match(recorded.markdown, new RegExp(`^name: ${recorded.slug}$`, "m"));
});

test("recordSkillFromGraph reads array-form LiteGraph links", () => {
  const graph = {
    _nodes: [
      { id: 1, type: "LoadImage", widgets: [], inputs: [], outputs: [] },
      { id: 2, type: "PreviewImage", widgets: [], inputs: [], outputs: [] },
    ],
    links: { 9: [9, 1, 0, 2, 0, "IMAGE"] },
  };
  const recorded = recordSkillFromGraph(graph, { title: "preview" });
  assert.equal(recorded.ok, true);
  assert.match(recorded.markdown, /#1\.0 → #2\.0/);
  assert.match(recorded.markdown, /IMAGE/);
});

test("skillNameFromSlash prefers the typed name over the workflow title", () => {
  const typed = skillNameFromSlash("/record-skill portrait-look", "Unsaved Workflow");
  assert.equal(typed, "portrait-look");
  const bare = skillNameFromSlash("/record-skill", "Unsaved Workflow");
  assert.equal(bare, "Unsaved Workflow");
  const recorded = recordSkillFromGraph(sampleGraph({ prompt: "x", steps: 4 }), {
    title: "Unsaved Workflow",
    commandText: "/record-skill portrait-look",
  });
  assert.equal(recorded.slug, skillSlug("portrait-look"));
  assert.equal(recorded.path, recordedSkillUserdataPath("portrait-look"));
});

test("skillSlug collapses punctuation so the userdata path is a real file", () => {
  assert.equal(skillSlug("My Cool Graph!"), "my-cool-graph");
  assert.equal(skillSlug("   "), "recorded-graph");
  assert.equal(recordedSkillUserdataPath("My Cool Graph!"), "skills/my-cool-graph/SKILL.md");
});

test("recordSkillFromGraph clips oversized widget values instead of dumping them", () => {
  const huge = "prompt-" + "x".repeat(SKILL_WIDGET_VALUE_CAP + 40);
  const graph = sampleGraph({ prompt: huge, steps: 1 });
  const recorded = recordSkillFromGraph(graph, { title: "clip" });
  assert.ok(!recorded.markdown.includes(huge));
  assert.match(recorded.markdown, /prompt-x+\…/);
});

test("persistRecordedSkill POSTs the markdown to userdata at the skill path", async () => {
  const markdown = recordSkillFromGraph(sampleGraph({ prompt: "persist-me", steps: 7 }), {
    title: "Persist Demo",
  }).markdown;
  const path = recordedSkillUserdataPath("persist-demo");
  const calls = [];
  const result = await persistRecordedSkill({
    fetchApi: async (route, init) => {
      calls.push({ route, init });
      return { ok: true, status: 200 };
    },
    path,
    markdown,
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, path);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, markdown);
  assert.ok(calls[0].route.includes(encodeURIComponent(path)));
  assert.match(calls[0].route, /overwrite=true/);
});

test("persistRecordedSkill reports a write failure instead of claiming the skill was saved", async () => {
  const path = recordedSkillUserdataPath("nope");
  const missingApi = await persistRecordedSkill({ fetchApi: null, path, markdown: "x" });
  assert.equal(missingApi.ok, false);
  assert.match(missingApi.error, /userdata API is not available/);
  const httpFail = await persistRecordedSkill({
    fetchApi: async () => ({ ok: false, status: 400 }),
    path,
    markdown: "x",
  });
  assert.equal(httpFail.ok, false);
  assert.match(httpFail.error, /400/);
});

test("#350 /record-skill is a local slash command that records via the shipped helpers", () => {
  assert.match(SRC, /from "\.\/lib\/record-skill\.js"/);
  const at = SRC.indexOf('cmd: "/record-skill"');
  assert.notEqual(at, -1, "a /record-skill slash command must exist");
  const entry = SRC.slice(at, SRC.indexOf('cmd: "', at + 10));
  const code = entry.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /recordSkillFromGraph\(/);
  assert.match(code, /persistRecordedSkill\(/);
  assert.match(code, /getGraphCtx\(/);
});
