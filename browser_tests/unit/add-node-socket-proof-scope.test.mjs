import test from "node:test";
import assert from "node:assert/strict";

import { registeredSocketTypes } from "../../web/js/lib/node-widget-materialization.js";

// panel#821 — placeholder; the real assertions land with the fix.
test("registeredSocketTypes over a single-class payload cannot see a sibling's output type", () => {
  const whole = {
    SeedVR2LoadDiTModel: { output: ["SEEDVR2_DIT"] },
    SeedVR2LoadVAEModel: { output: ["SEEDVR2_VAE"] },
    SeedVR2VideoUpscaler: { output: ["IMAGE"] },
  };
  const single = { SeedVR2VideoUpscaler: whole.SeedVR2VideoUpscaler };
  assert.equal(registeredSocketTypes(whole).has("SEEDVR2_DIT"), true);
  assert.equal(registeredSocketTypes(single).has("SEEDVR2_DIT"), false);
});
