import test from "node:test";
import assert from "node:assert/strict";

import {
  appendStoryboardCacheBust,
  createStoryboardIdentity,
  storyboardPosterUploadName,
  storyboardUploadName,
} from "../../web/js/lib/storyboard-cache-identity.js";

test("#1718 storyboard identities make source URLs and derived names distinct", () => {
  const first = createStoryboardIdentity();
  const second = createStoryboardIdentity();
  assert.notEqual(first, second);
  assert.notEqual(
    appendStoryboardCacheBust("/view?filename=clip.mp4&type=temp", first),
    appendStoryboardCacheBust("/view?filename=clip.mp4&type=temp", second),
  );
  assert.match(storyboardUploadName("clip", first), new RegExp(`^storyboard_clip_${first}\\.png$`));
  assert.match(storyboardPosterUploadName("clip", first), new RegExp(`^poster_clip_${first}\\.png$`));
});

test("#1718 cache bust preserves URL fragments", () => {
  const busted = appendStoryboardCacheBust("/view?filename=clip.mp4#frame", "attempt-1");
  assert.equal(busted, "/view?filename=clip.mp4&cmcp_storyboard=attempt-1#frame");
});
