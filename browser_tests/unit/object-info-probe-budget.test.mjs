import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  objectInfoSnapshotProbeDeadline,
  OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS,
  OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS,
} from "../../web/js/lib/object-info-probe-budget.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("#1734 keeps loopback object-info silence discovery at the local 2s bound", () => {
  for (const origin of [
    "http://127.0.0.1:8188",
    "http://127.42.0.9:8188",
    "http://[::1]:8188",
    "http://localhost:8188",
  ]) {
    assert.equal(
      objectInfoSnapshotProbeDeadline(origin),
      OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS,
      origin,
    );
  }
});

test("#1734 gives non-loopback object-info reads the remote 8s bound", () => {
  for (const origin of [
    "https://comfy.example.test",
    "http://192.168.1.20:8188",
    "https://pod.example.test/proxy/8188",
  ]) {
    assert.equal(
      objectInfoSnapshotProbeDeadline(origin),
      OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS,
      origin,
    );
  }
});

test("#1734 treats an unknown origin conservatively without becoming unbounded", () => {
  for (const origin of [null, undefined, "not a URL", "file:///tmp/panel.html"]) {
    assert.equal(
      objectInfoSnapshotProbeDeadline(origin),
      OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS,
      String(origin),
    );
  }
  assert.ok(OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS < 25_000);
});

test("#1734 production wiring selects from the page origin and keeps command bounding", () => {
  assert.match(
    PANEL_SRC,
    /const OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS = objectInfoSnapshotProbeDeadline\(pageComfyOrigin\(\)\);/,
  );
  assert.match(PANEL_SRC, /const SET_WIDGET_COMMAND_BUDGET_MS = 80000;/);
  assert.match(
    PANEL_SRC,
    /deadlineMs: budget\.bounded\([\s\S]*?OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS/,
  );
});
