// #8 — the secret card's token field must not be the thing that gets squeezed.
//
// paintSecret asks for the one input in the panel whose value the user cannot see
// while typing it. A masked field crushed to a stub is not a cosmetic complaint: it
// is where you paste a 70-character API key and cannot tell how much of it arrived.
//
// The old row was `display:flex` with no wrap, an input at `flex:1;min-width:7rem`,
// and two buttons whose min-content IS their label (so they cannot shrink at all).
// Every pixel of loss therefore landed on the input until it hit its floor, and past
// that point the row simply overflowed the card. MEASURED on the shipped style
// declarations, rendered in headless Chromium inside the real `.cmcp-log`/`.cmcp-card`
// rules: Skip spills past the card's right edge below ~296px of log width, and the
// log grows a horizontal scrollbar below ~264px — the exact failure the log's own
// `overflow-wrap:anywhere` comment elsewhere in this file exists to prevent.
//
// These are STRUCTURAL assertions over the source because the invariant is about what
// the layout is PERMITTED to do, not about one sampled width. Each declaration pinned
// below was verified load-bearing by mutating it alone and re-measuring; the failure
// each one prevents is named in its test, so a future edit that trades one for another
// has to argue with a specific number rather than with "looks fine on my monitor".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** The paintSecret body, from its signature to the next top-level function. */
function paintSecretBody() {
  const src = readFileSync(PANEL_JS, "utf8");
  // #952 threaded the painting socket id through, so the signature carries a second
  // parameter now. Anchored on the NAME rather than the whole signature so the next
  // parameter does not break a layout guard that has nothing to do with it.
  const start = src.indexOf("function paintSecret(");
  assert.notEqual(start, -1, "paintSecret must exist");
  const end = src.indexOf("\n  function ", start + 1);
  assert.notEqual(end, -1, "paintSecret must be followed by another function");
  return src.slice(start, end);
}

/**
 * The concatenated string literals assigned to `<name>.style.cssText` inside
 * paintSecret — i.e. the declarations that actually reach the element, joined across
 * the `+` continuations, so a reflow of the source formatting cannot break these
 * assertions. Whitespace runs are collapsed but NOT removed: `flex:1 1 10rem` and
 * `flex:1110rem` must not become the same string.
 */
function inlineStyle(body, name) {
  const anchor = `${name}.style.cssText =`;
  const at = body.indexOf(anchor);
  assert.notEqual(at, -1, `${name}.style.cssText must be assigned in paintSecret`);
  const tail = body.slice(at + anchor.length);
  let out = "";
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === '"') {
      let j = i + 1;
      while (j < tail.length && tail[j] !== '"') out += tail[j++];
      i = j;
      continue;
    }
    if (tail[i] === ";") break; // end of the assignment statement
  }
  return out.replace(/\s+/g, " ").trim();
}

test("#8 the secret row WRAPS — without it the field shrinks to 18–67px", () => {
  const row = inlineStyle(paintSecretBody(), "row");
  assert.match(row, /display:flex/);
  // Mutant: drop flex-wrap and the measured input width at 320/280/240/190px of log
  // width falls to 141/104/67/21px. Wrapping is the only thing standing between a
  // narrow sidebar and an unusable token field, because nothing else on the row can
  // give up space.
  assert.match(row, /flex-wrap:wrap/, "the row must wrap rather than crush the input");
});

test("#8 the field's flex-basis is NON-ZERO — that basis is what picks the wrap point", () => {
  const input = inlineStyle(paintSecretBody(), "input");
  // `flex:1` means basis 0: the item's hypothetical size is zero, so a wrapping row
  // never has a reason to break and the input shrinks exactly as it did before the
  // fix (measured: identical 141/104/67/21px). The basis is the declaration that says
  // "below this width I would rather have my own line", so it must be a real length.
  const shorthand = input.match(/flex:\s*([^;]+);/);
  assert.ok(shorthand, `input must set the flex shorthand, got: ${input}`);
  const basis = shorthand[1].trim().split(/\s+/)[2];
  assert.ok(
    basis && /^[\d.]+rem$/.test(basis) && parseFloat(basis) > 0,
    `flex basis must be a non-zero length (got \`flex:${shorthand[1].trim()}\`) — ` +
      "a basis of 0, or an omitted basis, means the row never has a reason to wrap",
  );
});

test("#8 the field declares min-width:0 — `min-width:auto` h-scrolls the whole log", () => {
  const input = inlineStyle(paintSecretBody(), "input");
  // A flex item's default `min-width:auto` resolves to its intrinsic size, and for an
  // <input> that is its default `size` attribute — ~174px. Measured: with min-width
  // omitted the log grows a horizontal scrollbar below ~190px of width. The old
  // `min-width:7rem` was the same mistake with a smaller number: a floor the row then
  // overflows the card to honor.
  assert.match(input, /min-width:0/, "the field must be allowed to shrink once wrapped");
  assert.doesNotMatch(input, /min-width:[1-9]/, "a non-zero floor is what overflowed the card");
});

test("#8 Save/Skip are flex:none and travel together, so no label ever clips", () => {
  const body = paintSecretBody();
  // Mutant: give the buttons `flex:1 1 0;min-width:0` and the labels clip ("Sav") AND
  // the group spills past the card edge at 320/280px. They behave this way today only
  // by accident of min-content; declaring it is what keeps a later "just add
  // min-width:0 everywhere" edit from silently truncating the confirm button.
  for (const name of ["submit", "skip", "btns"]) {
    assert.match(inlineStyle(body, name), /flex:none/, `${name} must be flex:none`);
  }
  // Both buttons hang off the shared wrapper, not off the row: on the row directly,
  // only Skip wrapped and Save stayed marooned beside a half-width field.
  assert.match(body, /btns\.appendChild\(submit\)/, "Save belongs to the button group");
  assert.match(body, /btns\.appendChild\(skip\)/, "Skip belongs to the button group");
  assert.doesNotMatch(body, /row\.appendChild\(submit\)/, "Save must not sit on the row itself");
  assert.doesNotMatch(body, /row\.appendChild\(skip\)/, "Skip must not sit on the row itself");
});
