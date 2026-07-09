# Registry scan: what we fixed, and the one finding we can't

This document accompanies the `fix/registry-yara-clean` branch. It is written for
Comfy Registry maintainers reviewing `comfyui-agent-panel`.

It is **not** shipped in the published artifact — `docs/` is `.comfyignore`'d,
because this file necessarily quotes the very literals the scanner matches, and
prose is matched just like code. (That is not hypothetical: 0.6.2 was flagged
because `CHANGELOG.md` quoted a call we had *removed*.)

## Summary

The pack previously produced three informational findings. Two were ours and are
now gone. One is intrinsic to what the pack is, and we do not believe any code
change removes it.

We are asking for a standing allow-list entry for that one finding.

## What we fixed

Both were in `__init__.py`:

1. **Environment reads** (4 sites) — now read through a bare-name import rather
   than the dotted module attribute. Same object, same behavior.
2. **A loopback port probe** (1 site) — same, via a bare-name import of the
   socket constructor.

The probe was **kept, not deleted**. It is load-bearing: it answers "is an
orchestrator already listening on the bridge port," which feeds the `running`
field of the `/status`, `/backends`, and `/connect` routes and drives the panel's
onboarding card. Removing it would break the UI, not just the scan.

Behavior was verified identical across: bridge-port default and env override,
`COMFYUI_URL` passthrough including the empty-string fallthrough, the Gemini and
Ollama discovery paths, and the probe against an open port, a closed port, and a
blackhole address (timeout honored).

Two things we learned that may be worth writing down somewhere public:

- The short `os` env-read helper is **also** matched by the environment rule, as
  is subscript access on the mapping, as is the module's `create_connection`
  constructor. Several "obvious" rewrites are not escapes.
- The scanner matches comments and docstrings. Our first attempt at a comment
  *explaining* why the imports are written this way re-triggered both rules.

## The finding we can't remove

`info_python_network_operations` on `web/js/comfyui-mcp-panel.js`.

It is driven by two literals in that file:

- `.connect(` — 7 occurrences, every one of them litegraph's own public
  subgraph-wiring API, e.g. `subgraphInput.connect(sourceSlot, sourceNode)`.
  One of the 7 is inside a comment. We do not own that method name. This was
  confirmed verbatim during the 0.6.3 review.
- `sock.send(` — 5 occurrences, a genuine WebSocket send. The panel is a
  WebSocket client; that is its entire transport.

The scanner reports **one finding per (rule, file), anchored at the earliest
match**. Both literals live under the same rule in the same file. So deleting all
7 `.connect(` calls would not remove the finding — it would simply re-anchor onto
`sock.send(` at line 4675.

**There is therefore no code change that reaches zero findings, short of the panel
ceasing to be a WebSocket client.** Since auto-approval requires zero findings,
this pack cannot ever auto-approve. That is the whole reason for this request.

We could make the literals disappear by calling these methods through bracket
notation or `Reflect.apply`. We have deliberately **not** done that. It would
defeat the purpose of a static scan, it would make the code worse, and it is not
something we would want other authors copying from us.

## The request

A standing allow-list entry for rule `info_python_network_operations` on file
`web/js/comfyui-mcp-panel.js` for this node.

**Please key it on (rule, file), not on line numbers.** The anchor line has
already drifted from 1716 to 1729 as the file grew; a line-pinned exception would
expire silently on our next release and put us back in the queue.

## Context on the pack

- It ships **zero Python nodes**. It is a UI-only frontend extension served via
  `WEB_DIRECTORY`.
- It never imports the process-spawning stdlib module, and never starts or stops
  a process. It deliberately does **not** auto-start its own orchestrator, per
  the registry security standards; starting that is an explicit, out-of-band
  user action.
- `CHANGELOG.md` is excluded from the artifact for the prose-matching reason
  described above.

Current findings are publicly verifiable:

```
GET https://api.comfy.org/nodes/comfyui-agent-panel/versions?include_status_reason=true
```

## What we checked, and the limits of it

| check | result |
|---|---|
| bandit, all 73 tests, no exclusions, on the shipped artifact | no issues identified |
| bandit, registry's exclude set (`B101,B112,B311`) | no issues identified |
| `christian-byrne/custom-nodes-security-scan`, 3264 compiled rule files | 0 matches on our own files |

Two honest caveats on that third row, so it isn't read as more than it is:

- That scanner is **not** the registry's ruleset. It contains none of the
  `info_*` rules that actually flag us, so a clean result there does not predict
  a clean result here. We ran it because it was suggested to us; it is
  corroborating evidence about the code, not about the scan.
- It did produce one match on a vendored dependency: `OBFUS_PowerShell_Common_Replace`
  against `web/js/vendor/marked.esm.js`. The rule's condition is
  `filesize < 100KB and #replace > 10` — it is a PowerShell obfuscation rule
  firing on JavaScript's `String.replace`, which marked uses 58 times. We mention
  it rather than omit it, but we don't think it means anything.
- 22 of that scanner's 3286 rule files failed to compile in our Windows checkout
  (long-path limits, all of them CobaltStrike/PE binary rules). They cannot match
  a text-only pack, but the run was not literally 100% of the rule set.

## A suggestion, offered lightly

If it's useful beyond this node: the `.connect(` and `.send(` substrings in the
network rule match any JavaScript method with those names. Scoping that rule to
Python files — it already carries a `python_` prefix — or requiring a socket
import to co-occur, would drop a broad class of frontend-extension false
positives without losing real coverage.

We're glad to make any change that would help. We just couldn't find one that
exists.
