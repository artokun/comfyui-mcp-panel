/**
 * #1757 recurrence — helpers behind the same-origin save rebind/retry.
 * Behavioural coverage of the shipped write lives in save-transport-failure.test.mjs
 * (it drives saveActiveWorkflow). These lock the flag, rebind, and probe shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySaveWriteLanded,
  clearRestartConfirmTimeout,
  consumeRestartConfirmTimeout,
  noteRestartConfirmTimeout,
  pageOrigin,
  rebindSameOriginSaveRoute,
  resolveSameOriginUserDataUrl,
  restartConfirmTimeoutPending,
  writeWithSameOriginRetry,
} from "../../web/js/lib/save-route-retry.js";

test("#1757 the restart-confirm timeout flag is one-shot", () => {
  clearRestartConfirmTimeout();
  assert.equal(restartConfirmTimeoutPending(), false);
  noteRestartConfirmTimeout();
  assert.equal(restartConfirmTimeoutPending(), true);
  assert.equal(consumeRestartConfirmTimeout(), true);
  assert.equal(restartConfirmTimeoutPending(), false);
  assert.equal(consumeRestartConfirmTimeout(), false);
});

test("#1757 rebindSameOriginSaveRoute writes the page host onto api.api_host", () => {
  const api = { api_host: "old.example:9" };
  const result = rebindSameOriginSaveRoute({ api, origin: "http://127.0.0.1:8188/extra" });
  assert.equal(result.rebound, true);
  assert.equal(result.origin, "http://127.0.0.1:8188");
  assert.equal(result.host, "127.0.0.1:8188");
  assert.equal(api.api_host, "127.0.0.1:8188");
});

test("#1757 rebindSameOriginSaveRoute refuses a non-http origin rather than guessing", () => {
  const api = { api_host: "old.example:9" };
  const result = rebindSameOriginSaveRoute({ api, origin: "file:///C:/ComfyUI" });
  assert.equal(result.rebound, false);
  assert.equal(api.api_host, "old.example:9");
});

test("#1757 pageOrigin ignores the browser's string 'null'", () => {
  assert.equal(pageOrigin({ origin: "null" }), null);
  assert.equal(pageOrigin({ origin: "http://127.0.0.1:8188" }), "http://127.0.0.1:8188");
});

test("#1757 resolveSameOriginUserDataUrl prefers apiUrl, else origin+route", () => {
  assert.equal(
    resolveSameOriginUserDataUrl("workflows/Foo.json", {
      apiUrl: (route) => `http://127.0.0.1:8188/api${route}`,
    }),
    "http://127.0.0.1:8188/api/userdata/workflows%2FFoo.json",
  );
  assert.equal(
    resolveSameOriginUserDataUrl("workflows/Foo.json", { origin: "http://127.0.0.1:8188" }),
    "http://127.0.0.1:8188/userdata/workflows%2FFoo.json",
  );
  assert.equal(resolveSameOriginUserDataUrl(""), null);
});

test("#1757 classifySaveWriteLanded reports missed / landed / unknown without guessing", async () => {
  assert.equal(await classifySaveWriteLanded({ path: "workflows/Foo.json", existsOnDisk: async () => false }), "missed");
  assert.equal(
    await classifySaveWriteLanded({
      path: "workflows/Foo.json",
      existsOnDisk: async () => true,
      expectedText: "{\"nodes\":[]}",
      readDiskBytes: async () => "{\"nodes\":[]}",
    }),
    "landed",
  );
  assert.equal(
    await classifySaveWriteLanded({
      path: "workflows/Foo.json",
      existsOnDisk: async () => true,
      expectedText: "{\"nodes\":[]}",
      readDiskBytes: async () => "{\"nodes\":[1]}",
    }),
    "missed",
  );
  assert.equal(await classifySaveWriteLanded({ path: "workflows/Foo.json" }), "unknown");
  assert.equal(
    await classifySaveWriteLanded({
      path: "workflows/Foo.json",
      existsOnDisk: async () => {
        throw new Error("HEAD failed");
      },
    }),
    "unknown",
  );
});

test("#1757 writeWithSameOriginRetry does not retry a non-transport failure", async () => {
  let writes = 0;
  await assert.rejects(
    () =>
      writeWithSameOriginRetry(
        async () => {
          writes += 1;
          throw new Error("Error storing user data file: 409 Conflict");
        },
        { allowUnknownRetry: true, afterRestartConfirmTimeout: true },
      ),
    /409 Conflict/,
  );
  assert.equal(writes, 1);
});

test("#1757 writeWithSameOriginRetry recovers when the probe says the write landed", async () => {
  const recovered = await writeWithSameOriginRetry(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { probe: async () => "landed", recoveredValue: { path: "workflows/Foo.json" }, afterRestartConfirmTimeout: false },
  );
  assert.deepEqual(recovered, { path: "workflows/Foo.json" });
});
