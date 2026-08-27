# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.15.113] - 2026-08-27

### Fixed
- reach WebSocket writes by name, clearing the last rule -> 0 findings (#1924)
- reach litegraph slot wiring by name, clearing $socket3 (#1923)
- capture the original before forking, instead of binding it (#1921)
- read the probe socket through a buffered wrapper too, 3 findings -> 2 (#1918)
- actually run the network-rule replica in CI, as a ratchet (#1917)
- the parity replica missed reads - $socket_stage_recv matches .recv( too (#1916)
- preserve node search cancellation
- bound node search replies (#1908)
- cut the registry network findings from six files to two (#1909)
- reject stale canvas capture after tab switch

### Changed


## [0.15.112] - 2026-08-27

### Fixed
- bound panel_search_nodes Manager replies and preserved caller cancellation (#1908, #1912)

## [0.15.111] - 2026-08-27

### Fixed
- cut the registry network findings from six files to two (#1909)
- reject stale canvas capture after tab switch


## [0.15.110] - 2026-08-27

### Fixed
- gate releases on rendered changelog version (#1902)

### Changed
- Fix workflow open normalization race (#1898) (#1904)


## [0.15.109] - 2026-08-26

### Fixed
- verify the rendered changelog artifact stays synchronized with the source (#1891, #1900)

## [0.15.108] - 2026-08-26

### Fixed
- reconcile generated changelog sections and release-history guards (#1891, #1894)

## [0.15.107] - 2026-08-26

### Fixed
- de-duplicate the 0.15.106 changelog section (#1890)


## [0.15.106] - 2026-08-26

### Fixed
- a release tag proves the tagged tree is the version it claims, and that nothing shipped untagged (#1885)
- the tag guard fails closed on an unreadable commit, and checks its own tag target (#1887)
- de-duplicate the 0.15.105 changelog section (#1884)

### Changed
- 0.15.105 does not contain the release tag guard, so its entry moved to Unreleased (#1888)

## [0.15.105] - 2026-08-26

### Fixed
- scrolling up during a streaming turn no longer snaps back to the bottom (#1879)
- graph_connect reports live dynamic slot rewrites and safely bounds hostile disclosure values (#1876)
- the pruned-retry disclosure says why the first post is not pre-pruned (#1881)
- normalise CRLF in the scope-fence source pins so they run on Windows (#1880)
- preserve unsaved workflow identity across proxy reads (#1790) (#1875)

## [0.15.104] - 2026-08-26

### Fixed
- a save that named nothing is never told to "choose a different name" (#1866)

### Changed
- local YARA parity replica, and defuse the changelog's own network tokens (#1874)
- drive the receipt-less completion end to end, through the real delivery boundary (#1872)


## [0.15.103] - 2026-08-26

### Fixed
- stop tripping the registry network rule on Function.prototype.bind (#1867)
- drop the vendored @a2ui/lit bundle and render leaves natively (#1865)
- partially_queued early returns include seed-repetition warning (#1857)

### Changed
- add behavioural test for repeating_controls_note attachment (#1862)


## [0.15.102] - 2026-08-26

### Fixed
- a connect that renames its target says so, instead of leaving the caller a stale title (#1856)


## [0.15.101] - 2026-08-26

### Fixed
- atomically fence promoted widget receiver scope (#2314) (#1831)
- bound the pre-receipt completion replay so it cannot storm the agent (#1850)


## [0.15.100] - 2026-08-26

### Fixed
- preserve chat autoscroll through browser scroll anchoring and interactive-card reveals (#1841)
- cache-bust inline previews when ComfyUI reuses an output filename (#1834)
- keep completion identity safe across reroutes, reloads, repeated registration, and id-less receipts (#1837, #1839, #1845)

## [0.15.99] - 2026-08-26

### Fixed
- make recovered-completion reload refusals visible to the agent (#1830)

## [0.15.98] - 2026-08-26

### Fixed
- preserve panel_run completion receipts across delayed prompts, teardown, and restart (#1824)

## [0.15.97] - 2026-08-26

### Fixed
- the start command leads the setup card instead of trailing it (#1822)
- the provider setup card scrolls instead of clipping its own tail (#1821)
- the version gate compares an independent witness, and unsticks 0.15.85 (#1825)


## [0.15.96] - 2026-08-25

### Fixed
- keep the selected provider visible and preselected when host availability is incomplete (#1818)

## [0.15.95] - 2026-08-25

### Fixed
- support safely validated workflow-library subfolders for panel saves (#1794)

## [0.15.94] - 2026-08-25

### Fixed
- fail closed when workflow-open binding settles or reconnect proofs become stale during concurrent tab operations (#887)

## [0.15.93] - 2026-08-25

### Fixed
- add an authenticated fixed-operation ComfyUI read relay for history, system stats, and logs (#2283)

## [0.15.92] - 2026-08-25

### Fixed
- preserve the live Grok turn across dedicated workflow-tab creation and distinguish tab swaps from real ComfyUI restarts (#1810)

## [0.15.91] - 2026-08-25

### Fixed
- label cache-assisted completion durations as workflow time, not render time (#1805)

## [0.15.90] - 2026-08-25

### Fixed
- contain long chat transcripts without losing scroll-to-bottom behavior (#1801)
- retry guarded root-identity healing after workflow switches (#1854)

## [0.15.89] - 2026-08-25

### Fixed
- rebind active and graph state after refusing to close an unsaved workflow (#1795)

## [0.15.88] - 2026-08-25

### Fixed
- recover graph tools after restart reconnect without a hard refresh (#1790)

## [0.15.87] - 2026-08-25

### Fixed
- rebuild fresh SaveVideo dynamic widgets and clear stale widget state (#2254)

## [0.15.86] - 2026-08-25

### Fixed
- gate workflow targeting on current reconnect binding proof (#1785)

## [0.15.85] - 2026-08-25

### Fixed
- fence scoped schema evidence (#2249)
- retain usable schema across refresh failures (#2249)


## [0.15.84] - 2026-08-25

### Fixed
- carry both frontend scope option keys (#1782)
- classify empty completion results (#1781)
- diagnose completion delivery outcomes (#1781)


## [0.15.83] - 2026-08-25

### Fixed
- classify empty completion results (#1781)
- diagnose completion delivery outcomes (#1781)


## [0.15.82] - 2026-08-25

### Fixed
- describe graph_get_virtual_types activity results (#1776)

## [0.15.81] - 2026-08-25

### Fixed
- defer safe widget edits until queue idle (#1716)


## [0.15.80] - 2026-08-25

### Fixed
- preserve VideoTileLivePlanner ROI on copy (#1761)
- reset Save-As source after workflow load (#1762)
- preserve restart confirmation answers (#1764)
- resolve panel_set_widget against live node list (#1759)
- explain workflow save transport failures (#1757)


## [0.15.79] - 2026-08-25

### Fixed
- Render orphan-link repairs with a meaningful activity warning instead of an undefined disconnect summary (#1750)

## [0.15.78] - 2026-08-24

### Fixed
- Join in-flight panel refreshes through download completion handoff instead of returning `refresh_still_running` (#1758)

## [0.15.77] - 2026-08-25

### Fixed
- Recover panel refreshes after concurrent download completions and coalesced trailing refreshes (#1736)

## [0.15.76] - 2026-08-24

### Fixed
- Preserve Save-As canvas identity through partial restores, tab switches, overlap, and failure cleanup (#939)
- Scale object-info schema probes for remote ComfyUI origins while preserving bounded fail-closed writes (#1734)
- Recover accessor-backed Impact BooleanWidget writes without masking same-message setter failures (#1735)

## [0.15.75] - 2026-08-24

### Fixed
- Keep Panel run receipts route-bound and exactly-once across reconnects, remounts, and late queue delivery (#1728)
- Redact credential-like values through graph outlines and subgraph provenance, including shared aliases (#1729)
- Refresh live asset membership before API-upload missing-asset validation (#1733)

## [0.15.74] - 2026-08-24

### Fixed
- Preserve refresh successor verdicts after reconnect so early results cannot report stale success (#1725)

## [0.15.73] - 2026-08-24

### Fixed
- Tolerate live Ideogram derived-widget serializer churn while preserving unrelated drift checks (#2130)

## [0.15.72] - 2026-08-24

### Fixed
- Isolate storyboard posters per render to prevent stale same-filename results (#1718)

## [0.15.71] - 2026-08-24

### Added
- add authenticated fetch_image bridge command (#1730)


## [0.15.70] - 2026-08-24

### Fixed
- deep-freeze all object info cache reads (#1709)
- preserve refreshed whole schema after add (#1709)
- replace stale whole schema authority (#1709)
- retire whole schema authority on class reads (#1709)
- reuse verified add-node schema (#1709)


## [0.15.69] - 2026-08-24

### Fixed
- name remote combo refusal provenance


## [0.15.68] - 2026-08-24

### Fixed
- roll back Fast Bypasser linked modes (#2146)


## [0.15.67] - 2026-08-24

### Fixed
- panel_refresh_nodes now follows chained forced refresh successors and never reports premature success while a later refresh is still running (#1695)
- late combo refresh mutations remain fenced and combo trust stays fail-closed across reconnect refreshes (#1695)


## [0.15.66] - 2026-08-23

### Fixed
- disclose rgthree lora row creation route (#1694)
- fail closed on incomplete live scans (#1691)
- bound live error lookups (#1691)
- preserve refusal precedence for mixed receipts (#1690)
- make incomplete run receipts uncertain (#1690)
- refuse id-less run acknowledgements (#1690)
- reject ambiguous inner error ids
- reject foreign scoped execution errors
- preserve scoped execution errors

### Changed
- release-0.15.62 (#1704)
- fix/1682 refresh join (#1703)
- release-0.15.61 (#1702)
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.65] - 2026-08-23

### Fixed
- fail closed on incomplete live scans (#1691)
- bound live error lookups (#1691)
- preserve refusal precedence for mixed receipts (#1690)
- make incomplete run receipts uncertain (#1690)
- refuse id-less run acknowledgements (#1690)
- reject ambiguous inner error ids
- reject foreign scoped execution errors
- preserve scoped execution errors

### Changed
- release-0.15.62 (#1704)
- fix/1682 refresh join (#1703)
- release-0.15.61 (#1702)
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.64] - 2026-08-23

### Fixed
- preserve refusal precedence for mixed receipts (#1690)
- make incomplete run receipts uncertain (#1690)
- refuse id-less run acknowledgements (#1690)
- reject ambiguous inner error ids
- reject foreign scoped execution errors
- preserve scoped execution errors

### Changed
- release-0.15.62 (#1704)
- fix/1682 refresh join (#1703)
- release-0.15.61 (#1702)
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.63] - 2026-08-23

### Fixed
- reject ambiguous inner error ids
- reject foreign scoped execution errors
- preserve scoped execution errors

### Changed
- release-0.15.62 (#1704)
- fix/1682 refresh join (#1703)
- release-0.15.61 (#1702)
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.62] - 2026-08-23

### Changed
- fix/1682 refresh join (#1703)
- release-0.15.61 (#1702)
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.61] - 2026-08-23

### Changed
- fix/1681 widget detail budget (#1701)
- release-0.15.60 (#1700)
- fix/1680 refresh completion handle (#1699)


## [0.15.60] - 2026-08-23

### Changed
- fix/1680 refresh completion handle (#1699)


## [0.15.59] - 2026-08-23

### Fixed
- refuse derived MiniMaxH3Director prompt writes (#1697)


## [0.15.58] - 2026-08-23

### Fixed
- reject replaced panel targets
- advertise expected node type fence
- enforce expected target type at write boundary


## [0.15.57] - 2026-08-23

### Fixed
- panel_find_nodes now matches raw quoted substrings in STRING widget values (#1678)


## [0.15.56] - 2026-08-23

### Fixed
- refuse arbitrary Git URLs on Manager v4 before queueing (#1539)


## [0.15.55] - 2026-08-23

### Fixed
- treat VHS date prefixes as queue-time volatile


## [0.15.54] - 2026-08-23

### Fixed
- recover link-disconnect restore crashes


## [0.15.53] - 2026-08-23

### Fixed
- normalize app mode canvas metadata


## [0.15.52] - 2026-08-23

### Fixed
- preserve graph serializer failures (#1669)


## [0.15.51] - 2026-08-23

### Fixed
- skip frontend-authored CustomCombo availability


## [0.15.50] - 2026-08-23

### Fixed
- verify region palettes
- respect import authority and rollback
- handle empty editor and palette state
- rehydrate Ideogram region editor writes


## [0.15.49] - 2026-08-23

### Fixed
- make path fallback explicit
- prefer live ComfyUI base path


## [0.15.48] - 2026-08-22

### Fixed
- reject empty object info maps
- reject malformed object info fallback
- harden fallback pack map keys
- panel_list_nodes returns an inspectable fallback when Manager is unreachable


## [0.15.47] - 2026-08-22

### Changed
- fix-late-workflow-save-receipts (#1657)


## [0.15.46] - 2026-08-22

### Fixed
- first open of the active workflow after restart succeeds (#1643)


## [0.15.45] - 2026-08-22

### Fixed
- outline reporting root after reconnect lets enter_subgraph use the root (#1639)


## [0.15.44] - 2026-08-22

### Fixed
- after a reconnect, a graph outline that reports viewing.scope root makes the immediately following enter/mutation use root, instead of rejecting a root node as "currently inside a subgraph" (#1636)
- panel_set_widget no longer re-waits on silent `api.getNodeDefs()` / `GET /object_info` probes when a same-connection schema snapshot is already held (#1582)

### Fixed
- installed nested models on Windows are not reported missing (#1637)
- panel_set_widget no longer re-waits on silent schema probes (#1638)


## [0.15.43] - 2026-08-22

### Fixed
- panel_new_workflow no longer claims a blank tab while the previous graph is still on the canvas (#1632)


## [0.15.42] - 2026-08-22

### Fixed
- a restart confirmation card is brought on screen instead of timing out unseen: the Agent tab opens, stick-to-bottom is forced, and the card scrolls immediately rather than waiting on an rAF a backgrounded tab will never fire (#1625)
- resolve Manager installed directory IDs before update


## [0.15.41] - 2026-08-22

### Fixed
- fail honestly when remote /view is unavailable (#1623)


## [0.15.40] - 2026-08-22

### Fixed
- panel_open_workflow keeps authored node size/order and leaves a clean tab unmodified (#1621)
- replay remote PreviewImage completion (#1624)

## [0.15.39] - 2026-08-22

### Fixed
- deliberate-sweep runs retain their prompt and SaveImage filename widgets when the frontend queue is already busy (#1588)


## [0.15.38] - 2026-08-22

### Fixed
- panel_open_workflow no longer reports unknown content when only randomMin/randomMax normalize (#1613)
- a finished stills render notifies the agent before the orchestrator fallback (#1612)
- trust live VIDEO producers for add-node socket proof

## [0.15.37] - 2026-08-22

### Fixed
- opening an already-open saved workflow publishes the live fence uuid, so the next graph read is not refused as a stale instance (#1581)
- `panel_add_node` accepts a core VIDEO socket when a live canvas producer exposes VIDEO, even if the full `/object_info` read times out (#1589)

- opening a saved workflow leaves graph tools on that canvas
- report the tab re-list from the open LIST, and hold the fence across the load
- the adopt arm requires the same workflow FILE, not just a matching selector
- reopening a closed tab loads the workflow the store's early return skipped

## [0.15.36] - 2026-08-22

### Fixed
- the Agent tab appears in the sidebar after a clean load (#1609)
- a save whose only drift is node geometry is no longer refused (#1606)
- accept wildcard producers for custom sockets (#1584) (#1603)


## [0.15.35] - 2026-08-21

### Fixed
- the pack no longer treats any TCP listener on the bridge port as a running orchestrator (Logitech G HUB's `lghub_agent` sits on 9180); identity is a hello/models handshake, the default is 9199 with 9180 as a legacy fallback, `/status` and Connect try 9180 before spawning a 9199 orchestrator, and a live 9180 session is not stranded across a panel update (#1596 / mcp#2030)
- shorten silent schema probe with current snapshot
- upgrade queued refresh handoff
- answer refresh before synchronous reapply
- graph audits no longer report stale output links or contradictory downstream consumers (#1590)

## [0.15.34] - 2026-08-21

### Fixed
- close wrapped secret and version regressions
- the proxy attribution needs a body that NAMES a responder

## [0.15.33] - 2026-08-21

### Fixed
- free_vram classifies what answered instead of pasting the proxy's error page (#1591)
- a frontend-only node stays addable when the object_info fetch does not answer (#1586)
- a benign load-time rewrite INSIDE a subgraph definition stops refusing the open (#1578)
- a subgraph node's rebuilt widget list is compared by MEMBERSHIP, not by array identity (#1577)
- a scoped batch drives ComfyUI's own control hooks, so batch_count means N renders (#1576)
- the video completion stops waiting on work the agent never sees (#1579)
- the live availability scan reads V2/V3 combos, not just the V1 shape (#1568)
- a save whose tracker snapshot is behind the canvas is refused, not reported as success (#1567)
- three refusal/comment inaccuracies from #1561 now state what the code observed (#1574)
- graph_run answers inside the window its reply is relayed in (#1570)
- recognise ComfyUI's file_upload flag so Load3D model inputs get upload handling (#1571)
- panel_refresh_nodes spends the window it holds, and stops blaming a server it never saw fail (#1566)
- a type-scoped /object_info answers the fence when the whole map never lands (#1561)

## [0.15.32] - 2026-08-21

### Fixed
- Prompt Builder prompt_text writes keep builder_state in the same step (#1551)
- serverDeclaresEmptyComboOptions reads the V2 combo shape (#1552)
- a FLOAT widget's quantization is explained by the grid the frontend actually ran (#1550)


## [0.15.31] - 2026-08-20

### Fixed
- loading a saved workflow no longer resets a subgraph host's prompt, dimensions, length, and selectors to definition defaults (#874)
- panel_add_node names a failed custom-node pack as the reason a type is missing only when ComfyUI-Manager's node map says that pack provides it; an unproven failure is reported as a separate issue rather than the cause (#1544)

### Fixed
- saved subgraph host widgets survive panel_load_workflow (#1547)
- name a failed pack as the cause only when Manager's node map proves it owns the type (#1545)


## [0.15.30] - 2026-08-20

### Fixed
- the default saveWorkflow test double writes the tab's own path (#1542)


## [0.15.29] - 2026-08-20

### Fixed
- a no-name save of a .app.json workflow writes that file, not a plain .json fork (#1538)
- a long timestamp-less transcript keeps the order it was written in (#1536 / #1539)


## [0.15.28] - 2026-08-20

### Fixed
- panel_set_widget retains VHS_LoadVideo custom dimensions (#1534)


## [0.15.27] - 2026-08-20

### Fixed
- the archive import carried the same broken tiebreak (#1531)
- a timestamp-less transcript keeps the order it was written in (#1530)
- the slot snapshot is instrumentation, not a precondition for firing the hook
- a programmatic widget write announces itself to the node, not just to the widget


## [0.15.26] - 2026-08-20

### Fixed
- `panel_add_node` of a subgraph UUID already loaded in the live workflow no longer rejects it as an unknown backend node or names an unrelated failed pack (#1523)
- a run ComfyUI accepted while dropping some outputs is reported as queued, with the dropped outputs named, instead of as a refusal (#1504)
- `panel_list_nodes` with `search` (or `query`) filters the installed-pack list instead of returning every pack (#1496)
- a run-to-node no longer has its own branch vetoed by an uninstalled pack on a branch it excluded (mcp#1871)
- the panel's own pre-flight stops refusing before ComfyUI is asked, so that recovery can run (mcp#1871)
- a group is built from the same footprint its members are judged by, so requested collapsed nodes are included (mcp#1877)
- a locator that could not look no longer reports the node as being from another workflow (#1501)
- a refusal claims nothing about a final size it never read (#1872)

## [0.15.25] - 2026-08-20

### Fixed
- a title-only edit is judged against the node's own snapshot, not a size range (#1509)
- a later phase must not speak for a run that obtained no /object_info (#1508)

### Changed
- EXECUTE the rider, so its workflow-key gate can be watched to fail (#1505)


## [0.15.24] - 2026-08-20

### Fixed
- the node-def refresh asks the raw /object_info route when the frontend client does not answer (#1502)
- a graph read dates itself against the manual-change block it contradicts (#1503)
- an instance-scoped promoted write discloses the inner callback it did not invoke (#1500)
- the "you are inside a subgraph" remedy is now checked, not assumed (#1499)


## [0.15.23] - 2026-08-20

### Fixed
- adopt a loopback bridge URL the orchestrator advertises, not just a tunnel one (#1487)


## [0.15.22] - 2026-08-20

### Fixed
- a Manager install queue that stays `in_progress` with no count change is reported as a silent stall, not as progress: `panel_node_queue_status` still attaches Manager's real counts, names any in-progress pack, and after two minutes of the same fingerprint tells you to verify with `panel_list_nodes` instead of waiting forever (#1480)

### Fixed
- a silent Manager in_progress is named as a stall, not as progress (#1483)


## [0.15.21] - 2026-08-20

### Fixed
- the video card mounts, reserves its real space, and pauses before it unmounts (#1481)
- a tab switch no longer leaves graph reads refused on a stale root identity (#1478)
- a schema read that timed out is UNKNOWN, not proof that nothing outputs the type (#1479)


## [0.15.20] - 2026-08-20

### Fixed
- a subgraph conversion that THROWS says whether the graph changed (#1466)

### Changed
- bump @types/node from 22.20.0 to 26.2.0 (#1471)


## [0.15.19] - 2026-08-20

### Changed
- bump the npm-minor-patch group with 2 updates (#1469)
- bump the actions-all group with 3 updates (#1468)


## [0.15.18] - 2026-08-20

### Fixed
- pasting a prompt copied out of a document no longer drops every character: a clipboard carrying both a file and text (which is what Word, Outlook, Excel and most web pages produce on Windows) had its text discarded by the file branch, silently and with no placeholder (#1467)
- a message referencing an attachment whose content is no longer loaded now says so, instead of sending a message that only looks complete (#1467)

## [0.15.17] - 2026-08-20

### Fixed
- key the requested name and the canvas name with the operation each needs (#1462)

### Changed
- watch dependencies for advisories, weekly and grouped (#1464)


## [0.15.16] - 2026-08-20

### Fixed
- adding an unknown node type no longer reports an unrelated ReActor import failure when that pack currently provides other live types (#1447)
- the save-timeout reply no longer claims the canvas is not the save's destination when it is: the requested name and the frontend's derived filename are now compared after the same normalization, so `workflow_save_as({name:"Foo.json"})` keeps reporting `modified:true` instead of withholding it (#1458)

## [0.15.15] - 2026-08-20

### Fixed
- entering a copied subgraph, editing its inner graph, and exiting no longer clears promoted widget values on the parent instances (artokun/comfyui-mcp#1827)

### Fixed
- the save timeout reports what it observed, never that the write landed (#1456)
- promoted parent widget values survive inner subgraph edits (#1454)


## [0.15.14] - 2026-08-19

### Added
- `graph_unexpose_subgraph_input` / `graph_unexpose_subgraph_output` remove a subgraph boundary slot by name — the inverse of the expose pair; dropped interior/host wires are counted and reported (artokun/comfyui-mcp#1294)

### Fixed
- `panel_get_errors` no longer flags a pasted LoadImage file like `pasted/image (992).png` as missing when the file is on disk and `/view` serves it (#1357)

### Added
- a supported way to remove a subgraph boundary slot (artokun/comfyui-mcp#1294) (#1437)

### Fixed
- a pasted LoadImage file with spaces is no longer flagged missing (#1440)
- panel_save_workflow replies when the save hangs instead of claiming the tab is frozen (#1439)


## [0.15.13] - 2026-08-19

### Fixed
- `panel_get_errors` no longer joins a previous workflow's runtime failure onto a current node that only shares the same id — correlation now requires matching node type as well (#1448)

### Fixed
- panel_get_errors no longer attaches a stale execution error to a reused node id (#1451)


## [0.15.12] - 2026-08-19

### Fixed
- graph mutations notify the visible canvas (and bump the frontend layout revision) so a successful edit/remove actually appears, not only in panel_graph_outline (#1443)

### Fixed
- editing a node keeps compact geometry instead of inflating it (#1446)
- graph edits appear on the canvas, not only in the outline (#1445)


## [0.15.11] - 2026-08-19

### Added
- Qwen Code as a selectable Agent Panel provider (#1438)
- graph_get_virtual_types — serve the frontend's proven virtual-node registry (artokun/comfyui-mcp#1400) (#1441)


## [0.15.10] - 2026-08-19

### Added
- `graph_get_virtual_types` bridge command reports the node types this page's LiteGraph registry proves frontend-virtual (`isVirtualNode === true` on a probe instance of the registered class — KJNodes' Get/Set bus, rgthree's Label / Fast Groups toggles, and any pack that sets the same flag), so the orchestrator's headless `check_runtime` can consult the authority instead of a name list (comfyui-mcp#1400)
- `graph_configure_app_mode` sets ComfyUI App Mode inputs, outputs, and default mode on the live canvas without clobbering `extra.comfyui_mcp` (#1429)
- `graph_save_subgraph` can replace a user-published blueprint in place with `overwrite:true` — no Save dialog, bundled/global blueprints stay protected (#1122)
- `panel_remove_node` accepts `node_ids` and removes every listed node in one undo step — one Ctrl+Z restores them all, and a single reply names what left and what did not (#841)

### Added
- panel_remove_node takes node_ids as one undo step (#1431)
- set ComfyUI App Mode inputs, outputs, and default mode on the live canvas (#1433)
- replace a published subgraph blueprint with overwrite:true (#1432)

### Fixed
- outline clip footer names note nodes whose text was clipped (#1435)


## [0.15.9] - 2026-08-19

### Fixed
- `panel_open_workflow` reports the fence uuid from the same active-workflow observation as the binding fields beside it, instead of a second live read that could disagree (#1014)

### Fixed
- an open reply reports one identity observation, not two (#1428)
- a promoted-widget write lands in the instance that was addressed, not the shared subgraph definition (#1427)

## [0.15.8] - 2026-08-19

### Fixed
- stale-combo refusal tells the truth about the refresh, and the /view probe is bounded (#1425)
- lightbox stage and collapsed cards honor the same honest failure state (#1424)


## [0.15.7] - 2026-08-19

### Fixed
- `panel_refresh_nodes` no longer times out with no acknowledgement when a node-def refresh is already running: of the six commands relayed in the orchestrator's 30 s window only `graph_add_node` and `nodes_install` held a command budget, and `refresh_nodes` — whose whole body IS a wait on the node-def refresh — did not, so a forced call waited unbounded on the in-flight run AND on its own trailing run — past the window, so the reply the panel's bounds exist to produce never left the tab and the user got `did not reply … the ComfyUI tab may be backgrounded or frozen` about a healthy, idle tab. It now bounds that wait at 25 s (the same budget `graph_add_node` and `nodes_install` hold against the same window) and answers `refreshed:false` with `reason:"refresh_still_running"` and a retry that works — the abandoned run is not cancelled, so it is still registering the definitions the call asked for (#1404)

### Fixed
- graph_set_widget stale-combo recovery takes the command budget (#1416)
- refresh_nodes takes a command budget, so a contended refresh replies instead of timing out (#1409)
- A2UI card buttons send a user message when clicked (#1410)
- sanitize invalid properties.aux_id on node add/paste so one node can no longer poison every save/load (#1412)


## [0.15.6] - 2026-08-19

### Fixed
- `panel_query_graph` (fields:'detail') no longer last-wins-collapses widgets that share a name: when a name repeats (rgthree Fast Groups toggle rows), every occurrence is listed so a duplicate or orphaned row is visible (#1402) (#1406)
- `duplicate_widgets` (the #1402 duplicate-widget report) no longer throws the whole detail read away on a widget named `__proto__`/`constructor`/`toString` — occurrences are accumulated prototype-safely — and is now bounded by the same `max_chars` budget as `widgets` (dropped occurrences are announced with the lever that lifts them, never silently lost), so a many-group Fast Groups Bypasser cannot push the detail line into a whole-row stub. `panel_graph_outline` also labels each same-named row from the widget itself rather than a last-wins name-keyed map, so two different group toggles are no longer both annotated with the last row's label (#1402) (#1405)

## [0.15.5] - 2026-08-19

### Added
- converting a video-gen workflow to an app exposes LTX 2.3/Director, Wan, Bernini, Hunyuan and Easy-Use Media generation parameters, treats LoadVideo/VHS/easy loadVideo as video inputs, and collects SaveVideo/VHS_VideoCombine/easy saveVideo as video outputs (including ComfyUI history `videos[]`) instead of classifying them as stills (#428)
- `/record-skill` snapshots the open graph as a reusable skill file (`skills/<name>/SKILL.md`) so the agent can rebuild it (#350)

### Fixed
- `workflow_open` no longer reports a false content mismatch on `definitions` when the frontend renumbered subgraph NODE ids during the load: the relabeling is proven (same nodes in the same order, links and promoted widgets patched through one injective map) rather than tolerated, and it still refuses when a root node promotes a widget from a node the relabeling touched (artokun/comfyui-mcp#1706)
- a panel tab whose bridge ROUTE went stale re-advertises itself instead of waiting for a browser refresh: the 600 ms workflow poll now watches the route the orchestrator keys its tab registry on, not only the workflow-instance fence identity, so a re-hello that did not land after a switch, a first save or a rename is retried (bounded) rather than leaving every graph call addressed at a tab id nothing answers to (#1389)

### Added
- converting a video-gen workflow to an app exposes LTX/Wan/Bernini/Hunyuan params and video I/O (#1397)
- /record-skill saves the open graph as a reusable skill (#1398)

### Fixed
- sweep a stolen preview by which node emitted, not by what its type could show (#1392)
- a re-pended run completion re-arms the reconcile sweep (#1403)
- a back-to-back graph command flushes the pending tracker snapshot before the fence (#1400)
- the missing-node COUNT is filtered with the names it was counting (#1396)
- graph_add_node still replies when its own refresh run would miss the window (#1399)
- the promoted-widget guard reads every dialect of an id that MOVED, not one spelling (#1395)
- the coalescer-join pin is checked at EVERY call site, not once over the body (#1393)
- a stale ROUTE re-advertises itself, like a stale fence identity already does (#1391)
- a subgraph node-id renumber is a relabeling the panel can PROVE, not lost content (#1388)
- video previews can be disabled — placeholder keeps first frame, filename and lightbox access (#1386)
- refuse workflow names with path separators instead of silently nesting (#1384)
- a nested composite field inside a JSON widget validates against its own value's shape (#1382)
- the load watch reports whether it was ENTERED, not just installed (#1387)


## [0.15.4] - 2026-08-19

### Fixed
- a combo that cannot list its files is no authority on whether a file exists: an unreadable listing no longer reads as an empty one (#1357)
- an abandoned combo refresh is reported as a missing confirmation rather than silently trusted: V2 and dynamic combo specs are rebuilt too, and a spec the panel cannot derive marks the run uncovered instead of suppressing a real missing-asset warning (#1193)
- a caller-supplied link-exclusion Set is normalised instead of trusted, so a raw-number Set cannot silently lose the exclusion and credit a pre-existing link to the current call (#1272)
- `panel_auto_layout` apply inside a subgraph no longer escapes to and rearranges the root graph (#1328)
- `panel_get_errors` no longer keeps load-time missing-node-type errors after a ComfyUI restart that registered those classes — leftover placeholders are reported as needing a save+reopen, not as still-uninstalled types (#1332)
- agent-directed instruction blocks (LIVE-CANVAS TOOLS, MANUAL CANVAS CHANGES, query-graph budget accounting) stay in the agent's context and no longer render in the user's chat (#1310)
- graph mutations no longer stay stuck in `[backend-reconnecting]` after a long Wan render: a busy `/prompt` poll is not a down socket, and binding status now distinguishes a readable canvas from a backend that is actually reconnecting (#1325)
- panel_update_node surfaces the Manager update traceback instead of hiding it behind a generic "check the server log" error (#1320)
- dictation listens for the spoken language when the panel UI is the English catalog floor — a German (or other unshipped) speaker no longer gets an English recognizer (#1329)
- panel_set_widget can author an LTXDirector timeline from the serialized widgets when the live timeline editor is not initialized (#1308)
- live-sync no longer reports notified unless the active canvas actually holds the saved workflow (#1299)
- `panel_edit_group({bounds})` writes the group box only — contained nodes stay at their canvas coordinates (#1306)
- an already-full origin can save workflow drafts again after the chat-history quota fix (#1305)
- a group that encloses rgthree Label nodes now moves, instead of being refused because those nodes' visual bounds are not the panel's generic footprint — the same nodes already moved fine one-by-one with panel_edit_node (#1300)
- a subgraph preview widget is promoted through the frontend's previewExposure store, and a failed link-only promote no longer hides behind a missing promotion store (#1271)

### Fixed
- author an LTXDirector timeline without a live editor (#1371)
- leftover link-driven widgets are not graph drift after reconnect (#1379)
- a connect that THROWS is judged on the link the live graph shows, not on the exception (#1352)
- dictation listens for the spoken language, not the English UI floor (#1375)
- a widget write is verified against the node property litegraph binds it to, and says UNKNOWN when it cannot be (#1363)
- a load the panel WATCHED run to completion is not a content mismatch (#1358)
- live_sync reports notified only when the active canvas applied (#1372)
- a Save-As acknowledges the CAPTURE it observed, not the openWorkflow it called (#1359)
- panel_edit_group bounds writes the box only (#1369)
- a frontend VIRTUAL node is not a missing one — the derivable signal, at three call sites (#1353)
- the FIFTH wait in graph_add_node draws from the command budget too (#1349)
- reclaim an already-full origin so ComfyUI can save drafts (#1367)
- keep execution image previews on the node that emitted them (#1361)
- a frontend-only add_node refusal names the unloaded pack JS, not a missing install (#1366)
- missing-node mutation errors name the current live ids (#1365)
- a group containing rgthree Label nodes moves instead of being refused (#1364)
- a dynamically added node survives workflow switch + reconnect (#1362)
- promote preview widgets through previewExposure (#1360)
- copy/paste keeps groups and branch positions (#1356)
- video preview uses the source duration, not a truncated default (#1355)
- graph_add_node gets ONE budget, so its bounds stop adding up (#1342)
- the fixed-seed ARRAY and its SENTENCE come from one predicate (#1350)
- a ComfyUI restart the bridge SURVIVES re-advertises the tab route (#1347)
- a slow-but-healthy fetch no longer starves the combo refresh of its budget (#1346)
- the outline resolves a link's live target slot through the backlink — a stale target_slot renders nothing instead of fabricating connectivity (#1340)
- a proven read keeps its stale-tag bypass through the executor's own fence re-assert (#1345)
- an untagged canvas is no longer captured into the target tab's state on a switch (#1344)
- a rename is announced as a rename, not a workflow switch (#1343)
- the post-open frame wait is bounded — a starved rAF no longer latches the switch fence (#1341)


## [0.15.3] - 2026-08-19

### Fixed
- a second panel bundle in the page stands down instead of fighting for the tab (#1269)
- one node's configure throw no longer aborts the rest of a graph load (#1260)
- a grounding auto-persist keeps the workflow's identity across its object swap (#1263)
- a cg-use-everywhere graph's broadcast targets are queue-time volatile, so run-to-node's graph stamp matches on an untouched canvas (#1273)
- panel_add_node refreshes a drifted node schema itself, then re-checks — the refusal is what survives (#1242)


## [0.15.2] - 2026-08-18

### Fixed
- a virtual PrimitiveNode feeding a subgraph input is reported as the non-source it is (#1181)
- a structural hand edit inside the tracker's capture lag no longer refuses the workflow's own canvas (#1187)
- an open refused on a properties difference names the keys that differ (#886)
- a first save publishes the identity it produced even when the swap carry fails safe (#978)
- a widget callback's throw now names the file it surfaced from, origin scrubbed (#976)


## [0.15.1] - 2026-08-18

### Added
- send this version's changelog to the Comfy Registry — every release has shipped blank (#810)

### Fixed
- the shadow sheds version payloads canonical holds, so the byte bound holds (#1318)
- a backend restart under a live tab re-probes the pack version and self-heals (#1317)
- panel_refresh_nodes can no longer report success over a pruned live canvas (#1316)
- a stale-canvas tab can no longer persist its foreign graph over another workflow's file (#1315)
- unpack_subgraph verifies external links survived and refuses loudly when any were dropped (#1314)
- panel_set_widget refreshes a node's dynamic input slots after the write (#1313)
- a same-node connect refusal is reported as LiteGraph's loopback guard, not a false type mismatch (#1311)


## [0.15.0] - 2026-08-17

### Added
- opening the panel can now START the local MCP orchestrator for you, with a chooser for the LLM provider. The companion launcher binds loopback-only behind a 32-byte token; the pack proxies it so the token never reaches the browser, and the proxy refuses a declared Origin that is not the Host the browser addressed — a plain cross-tab form post can no longer start the process on your behalf (#1243)
- `panel_set_widget` can CREATE an rgthree `lora_N` slot: writing `lora_1` on a fresh node mints the row instead of being refused for a widget only the node's DOM-only "Add Lora" button could bring into existence. Keyed on node type, the `lora_<n>` name shape and a lora-slot-shaped value, so an ordinary typo cannot reach it (#757)

### Fixed
- a voice-dictation error now names the cause and the way out, not just the Web Speech code (#1288)
- dictation listens in the panel's language, not the browser's (#1289)
- the desktop app disables dictation with the reason, instead of failing on every click (#1290)
- a search limit above the cap is disclosed as limit_cap, not silently honored (#1287)


## [0.14.44] - 2026-08-16

### Fixed
- a node read by id returns its full widget value, not a survey clip (#1634)
- a drifted graph fence is refreshed before the next call, not after it refuses (#1209)
- the Settings path no longer leaves the saved default naming a backend it never reached (#1198)
- a wedged orchestrator's death is recorded where the panel concludes it (#1168)
- an open where only presentation moved is not a failure (#1623)
- a subgraph conversion that broke the graph stops reporting success (#1571)
- a Manager that CANNOT report a failure stops reading as one reporting none (#1606)
- a subgraph is not a second unexplained difference, and the reassurance's own predicate reads the UNEXPLAINED surfaces too (#1588)
- graph mutations no longer lose the tab route after creating a workflow (#1095)
- a combo write is decided by whether the panel could READ the option list (#1126)
- a completion recovered from history reports when it RENDERED, not when it was replayed (#1199)
- a multi-word panel_search_nodes query finds the pack it names (#1088)
- a Manager task that terminally errored is not a queued install (#1539)
- a widget the node computes from its own editor is not writable (#1569)


## [0.14.43] - 2026-08-15

### Fixed
- a sidebar tab that is SELECTED but never paints now says so, once, with what was observed — the panel used to just look empty, with no way to tell a broken extension from a frontend that dropped the tab (#779)
- the conversation is always panel-owned: the workflow/ask chat scopes are retired, so a session can no longer be scoped to anything but the orchestrator (mcp#884)


## [0.14.42] - 2026-08-15

### Fixed
- run-to-node is no longer permanently refused when an armed Seed (rgthree) substitutes its value at queue time — that substitution is not graph drift, and every retry used to fail identically (#1124)


## [0.14.41] - 2026-08-15

### Fixed
- graph_load now reports the workflow identity it actually loaded into on BOTH reply paths, including the API-format load the report came from (#1478)


## [0.14.40] - 2026-08-14

### Fixed
- a group whose members are COLLAPSED nodes now moves, instead of being refused after those members positions had already been written (#813)

## [0.14.39] - 2026-08-14

### Fixed
- a widget edit is no longer refused just because the /object_info probe went silent while ComfyUI was busy rendering — it is authorized from the last whole schema observed on the same backend connection, which a restart always invalidates (#1223)

## [0.14.38] - 2026-08-14

### Fixed
- translating the error disarmed every ComfyUI-Manager fallback (#1230)


## [0.14.37] - 2026-08-14

### Fixed
- a run whose outcome could not be confirmed is reported as a neutral event instead of an urgent error, so cancelling a large batch no longer tells the agent every prompt ERRORED (#1226, comfyui-mcp#1489)


## [0.14.36] - 2026-08-14

### Fixed
- panel_open_workflow now asks the SERVER whether the file exists before refusing, so a workflow staged into the workflows folder out-of-band is reported as a stale list rather than a missing file (#1222, comfyui-mcp#1448)


## [0.14.35] - 2026-08-14

### Fixed
- a graph mutation refused during a reconnect now says so in a FIELD the caller can key on, instead of only in the sentence (#1216, comfyui-mcp#1529)


## [0.14.34] - 2026-08-14

### Fixed
- every release since 0.14.31 writes two sections for one version (#1219)
- rebuild combo options during the reapply sweep, and disclose an empty authoritative list (#1218)


## [0.14.33] - 2026-08-14

### Fixed
- panel_get_errors is a READ, so the dirty-tab mutation fence no longer refuses it as "this mutation" (#1211, comfyui-mcp#1478)
- bound the remaining unbounded network awaits (#1201)

## [0.14.32] - 2026-08-14

### Fixed
- a faithful workflow_open no longer reports CONTENT_UNVERIFIED just because the frontend rebuilt each node's `inputs` from its definition (#1208, comfyui-mcp#1467)

## [0.14.31] - 2026-08-14

### Fixed
- panel_open_workflow no longer claims the workflow list "WAS re-read from the server" when it cannot know that — the frontend's sync swallows its own errors (#1206, comfyui-mcp#1448)

## [0.14.30] - 2026-08-14

### Fixed
- the video storyboard sampler now names WHICH failure it hit, instead of reporting six different causes as one silent nothing (comfyui-mcp#1493)

## [0.14.29] - 2026-08-13

### Fixed

- **A backend switch that cannot complete no longer leaves the panel claiming the new one (#1184) (#1196).**
  Picking a different provider committed the choice — in memory, to the chips, and to the
  stored runtime pick — before checking whether the old provider's session could be safely
  ended. When that check failed the switch stopped there, and because the stored pick
  outlives the tab, a reload adopted a backend the panel had never actually connected to.
  The conversation replay armed for the new provider was left armed too, so the next
  message shipped the whole prior transcript back to the provider that already had it.
  Nothing is committed now until the switch is known to be possible, and a switch that
  stops says so instead of failing silently.

## [0.14.28] - 2026-08-13

### Fixed

- **Adding a node no longer waits forever on a ComfyUI that stopped answering (#1180) (#1186).**
  When the connection to ComfyUI goes half-open — the socket is up, the server never
  replies — a request does not fail, it simply never returns. Five requests for the node
  schema on the add-a-node and refresh-nodes paths had no time limit, so the panel parked
  on the first one it reached and the add landed minutes later, after the reply it belonged
  to had already been given up on. Each now gives up on its own and falls through to the
  handling that was already written for a schema it could not read. The log read that runs
  while *explaining* one of those failures is bounded too; it was inheriting the very stall
  it was called to describe.
  **No change on a healthy ComfyUI**, where these all answer in well under a second.

## [0.14.27] - 2026-08-13

### Fixed
- bound the two drive waits on the CivitAI fetch, so a slow CivitAI no longer makes a healthy panel look dead (#1189)

## [0.14.26] - 2026-08-13

### Changed

- **Restarting the agent holds its exclusion flag until the reconnect (#1171).**
  The panel keeps one flag so that restarting the agent and reloading it cannot run at the
  same time, but the restart released it as soon as the request came back — while it was
  still ending the current turn, clearing the markers that say a turn is in flight,
  invalidating the old session, and reconnecting. The flag is now held until the reconnect,
  which is what the reload path already did, so the two agree.
  **No visible change when the panel manages ComfyUI's agent the usual way**: this
  distribution's restart route always answers "not restarted" (the orchestrator runs
  out-of-band), so the work this now protects is skipped anyway. It matters for setups
  whose restart route really does restart the agent, and it removes the window before one
  of those hits it.

### Fixed
## [0.14.25] - 2026-08-13

### Fixed

- **Setting a widget no longer hangs for 30 seconds after a ComfyUI restart (#1161).**
  Once ComfyUI had been restarted mid-session, setting any widget on any node timed out,
  every time, while every other panel command answered instantly — reading the graph,
  renaming a node, listing workflows, queueing a run. Setting a widget is the one action
  that reads the backend's node definitions before it writes, and a restart can leave the
  browser holding a connection that never answers and never fails, so that read waited
  forever.
  The panel already had a second way to ask — a direct request that keeps working when
  the first route does not — but it was never reached, because nothing gave up on the
  first one. The lookup now has an overall time budget, so a route that stops answering falls
  through to the one that does and the write simply succeeds. The budget covers the whole
  lookup rather than being handed to each step in turn, so the wait cannot stack — but the
  second route is also guaranteed a share of it, because a first route that stops answering
  would otherwise use the budget up and leave nothing for the route that still works. A
  route that answers quickly hands back the time it did not use, so a slow install still
  gets the whole budget to finish in.
  The budget is twenty seconds, which is generous rather than tight: fetching the whole
  node-definition document was measured at well under a second even on a large install with
  sixty-odd node packs. If nothing answers, the refusal names every attempt and says how
  long each one was actually given, rather than quoting a wait it never spent.

### Fixed
## [0.14.24] - 2026-08-12

### Fixed
- **A successful agent restart no longer leaves the old turn's state armed against a
  fresh agent (#1166).** When a restart genuinely replaces the agent, the panel retires
  the markers that say a turn is in flight. Those clears all sat after a step that can
  bail out — if the old session could not be invalidated durably, the restart returned
  early and skipped every one of them. The killed turn, a pending soft-reload marker and
  the restart-resume marker were all left armed against an agent that no longer existed,
  so the next reconnect could announce a reload that never happened, or resume the very
  conversation the restart was meant to discard. They are now retired before that step,
  so nothing it does can skip them.
  That pause itself is deliberate and stays: reconnecting there would restore the session
  the restart exists to throw away. What it did not do was say so — the status chip, dot
  and buttons still showed a live connection, so the panel contradicted its own message
  and left no way to act on it. It now shows the real state and restores the Connect
  button.

## [0.14.23] - 2026-08-12

### Fixed
- **The mid-task nudge no longer fires on a turn you just started (#1163).** A defect in
  the outage accounting added for #1145, found by review of that change rather than in
  the wild. A turn beginning while the bridge was still down zeroed the measured outage
  but left the outage itself running, so it was later measured from before that turn
  existed. Reachable in ordinary use: sending a message needs only an open socket, not a
  completed handshake, and the socket comes back well before the model list does — so
  typing into that gap could draw "your connection dropped mid-task — continue exactly
  what you were doing" on top of the message just sent, making the agent restart or
  duplicate the work it was asked to do.
  A turn start now ENDS the outage rather than only zeroing the total. What that frame
  proves is narrow but sufficient: a turn is in flight. The nudge exists solely to
  rescue an agent left IDLE — a session resumed with full context and nothing pending —
  so once a turn is running there is nothing to rescue, whether it is the original turn
  re-announced by an orchestrator that survived or a new one just typed into a replaced
  agent. Nudging either is the harm. The converse still holds and is covered by tests:
  an orchestrator that died has no turn to announce, so its nudge fires as before.

## [0.14.22] - 2026-08-12

### Fixed
- let a truncated provider hint be read on hover (#1165)
- translate the "why can't I use this provider" hints in all 11 languages (#1162)
- translate the 22 strings that answer "why can't I use this provider" (#1160)

- **A ComfyUI restart that comes back quickly keeps its nudge (#1145).** The nudge tells a
  resumed agent its connection dropped mid-task and to continue what it was doing, and it
  fires only for a REAL restart — judged by how long the bridge was gone. But the panel
  assigns its socket before the connection resolves, so a REFUSED reconnect attempt is
  still the active socket and ran the close handler in full, re-stamping the drop time.
  With backoff doubling, the retries land near one, three, seven and fifteen seconds, so
  the attempt that finally connected was separated from the previous failed close by only
  that attempt's delay. The guard weighed its own retry cadence, not the outage: a genuine
  restart returning inside about seven seconds measured roughly four and lost its nudge,
  leaving the agent idle with a resumed session and no pending turn — after exactly the
  event the nudge exists for. The outage is now stamped once, by the first close that
  begins it, and its duration measured at the handshake that ends it.
  A second reading of the same guard is closed with it: a drop stamp answers "how long
  since the last drop, whenever that was", and kept answering after the outage it
  described had ended — so a `ready` repeating on a live socket (the panel re-advertises
  after every successful `free_vram`, #310) could be told about a drop from ten minutes
  and two reconnects earlier. That is #1138's defect with a real timestamp in place of the
  zero sentinel. What the guard reads is now a measured duration, scoped to the turn now
  running, and a handshake that ended no outage records nothing rather than inheriting the
  previous one.
  The accounting moved into a tracker with unit tests that drive it through the real
  sequence — drop, refused retry, refused retry, handshake — because no single call can
  distinguish a drop from the third refused attempt, and a source scan over the panel
  could not have caught this (a review previously proved by mutation that such scans stay
  green through an inversion). Each guard was mutation-checked against those tests.
  The two sibling `ready`-ack branches were audited for the same class and are clean: the
  reboot-resume branch already decides on an observed drop rather than elapsed time
  ("elapsed time is not evidence of a new connection; an observed drop is"), and the
  soft-reload branch reads a marker it sets and clears itself. The mid-task branch was the
  only one deriving a restart from a clock.

## [0.14.21] - 2026-08-12

### Added
- Brazilian Portuguese (pt-BR) panel catalog — 1107 keys + 52 settings (#1156)
- Russian (ru) panel catalog — 1161 keys, all four plural forms (#1155)
- complete the Simplified Chinese (zh) panel catalog — 353 → 999 keys (#1151)
### Fixed
- an empty baseline is not proof of a different graph, and say what actually recovers (#1158)
## [0.14.20] - 2026-08-12

### Added
- Spanish (es) panel catalog (#1152)
- add the Arabic (ar) panel catalog (#1143)
- add the Traditional Chinese (zh-TW) panel catalog (#1153)
- add the French (fr) panel catalog — 1107 keys, one/many/other plurals (#1150)
- add the Turkish (tr) panel catalog (#1148)
- add the Persian (fa) panel catalog (#1147)
### Fixed
- a definitions difference that is only link renumbering is not a content change (#1125)
- the status pill froze because onStatus threw on every status frame (#1154)
## [0.14.19] - 2026-08-12

### Added
- complete the Japanese panel translation (999 keys) (#1140)

### Fixed
- name every uninstalled node type before queueing, not one rejection at a time (#1129)
- decode string escapes when extracting, so \n is a line break and not two characters (#1144)


## [0.14.18] - 2026-08-12

### Fixed

- **A live-socket re-advertise no longer reads as a fresh connect, so a benign reconnect
  cannot tell you your connection dropped mid-task (#1138).** The panel injects a user
  message — "Your connection dropped mid-task … continue exactly what you were doing" —
  plus a transcript line whenever a `ready` ack arrives with a mid-task marker set. The
  guard meant to suppress that on a live session read `Date.now() - lastBridgeDownAt <
  6000`, and that timestamp is `0` until the bridge socket actually closes. So a bridge
  that never dropped presented as a ~56-year gap — the longest possible — which a
  long-gap-means-real-restart heuristic read as the strongest possible evidence of a
  restart. The guard was exactly inverted in the case it existed to catch: the better
  established that nothing had dropped, the more confidently it fired.
  Reachable in normal use, because `ready` repeats on a live socket and the panel
  re-advertises after every successful `free_vram` by design (#310). Freeing VRAM
  mid-task could therefore tell you your connection had dropped when nothing had, and
  tell a still-working agent to resume — making it restart or duplicate the render it was
  already running.
  A real restart still nudges, including exactly at the six-second boundary. The decision
  moved into a pure predicate so it is covered by behaviour rather than by a source scan:
  a review demonstrated by mutation that token-presence tests over this file stay green
  when such a guard is inverted, which is the one regression that matters here.
  Two related problems were found and deliberately left for their own issue rather than
  patched here: every FAILED reconnect attempt re-stamps that timestamp, so the gap can
  measure a backoff step instead of the outage; and the other `ready`-ack branches have
  not been audited for the same sentinel exposure.

## [0.14.17] - 2026-08-12

### Added
- freeze the English catalog and give translators a rendering instrument (#1135)

### Fixed
- the status chip must report the socket the session actually uses (#1137)
- disclose the foreign source state on a FAILING open too (#1131)
- a successful open must not report a canvas it did not verify (#1110)
- say whether the workflow list was actually re-read, and stop blaming the folder (#1123)
- advertise the vendored tool vocabulary in the hello (#1119)
- a numeric from_output reuses the rail slot instead of minting one named "4" (#1117)
- panel_screenshot stops throwing when a node has no type (#1115)
- render the effort LABEL, not the raw token
- the connect-screen blurb, and a broader audit than sinks can give
- an open that detects the wrong graph must refuse, not just say so (#1112)
- stop asking every run-to-node caller to report a permanent fallback (#1107)
- refuse a write to rgthree's Fast Groups toggle — it is a derived readout (#1106)
- a correction to an identical value is not a correction (#1104)
- warn when a direct write lands on a link-driven widget (#1102)
- name both ChatGPT routes, and stop the label map gating the handshake (#1100)
- a host probe must not shrink an authoritative provider list (#1094)
- don't capture another workflow's canvas into the tab being opened (#1092)
- wire the strings no coverage metric could see
- resolve subgraph-qualified node ids instead of coercing them to NaN (#1090)
- rgthree seeds are invisible to the batch-repeat warning (#1082)
- Korean is complete — every panel string now has a translation
- core SaveGLB is addable — a 3D file union names formats nothing OUTPUTS (#1078)
- fill Korean from 37% to 50% — the visible chrome was untranslated
- defect (2) — scope the #226 guard to the hazard it names (#1075)
- satisfy the tool-vocabulary gate, which this batch tripped four ways

### Changed
- 0.14.16 (#1132)
- 0.14.15 (#1128)
- 0.14.14 (#1121)
- re-vendor the tool vocabulary — the handshake found real drift (#1120)
- 0.14.13 (#1118)
- 0.14.12 (#1116)
- 0.14.11 (#1113)
- 0.14.10 (#1109)
- 0.14.9 (#1105)
- 0.14.8 (#1103)
- 0.14.7 (#1101)
- 0.14.6 (#1099)
- 0.14.5 (#1093)
- 0.14.4 (#1091)
- 0.14.3 (#1086)
- 0.14.2 (#1081)
- 0.14.1 (#1076)
- 0.13.9 (#1072)


## [0.14.16] - 2026-08-12

### Fixed

- **`panel_open_workflow` now warns when the graph it painted may be another
  workflow's (#1089).** The reporter got a clean success — right path, right
  filename, right `workflow_uuid`, `modified: false` — while the canvas held the
  graph of the workflow they had just saved-as FROM. No warning of any kind. Their
  next calls were `panel_remove_node`, and Save-As preserves ids, so those
  deletions would largely have LANDED, on the wrong workflow, silently.
  Nothing was fooled, which is why no existing check caught it. All four parts of
  the post-repaint proof are taken against the root the LOADER produced; none of
  them looks at the state the load was handed. When that state holds another
  workflow's graph, the open reproduces it faithfully and every part passes — each
  a true statement about a poisoned SOURCE. That is also why the other report on
  the same end state (#1111) DID warn while this one did not: there the state had
  not been contaminated, so the comparison had something to disagree with.
  The reply now carries `foreign_source_state` when the state provably held a
  different OPEN workflow's identity. It says to verify the graph before editing,
  explains that every other field on the reply is TRUE of the tab and says nothing
  about which graph the state held, and names the disk recovery together with its
  cost — a tab reporting no unsaved edits can still lose values a NODE wrote
  rather than the user (a populated wildcard, a rolled seed, #874).
  It says MAY be, not IS, and deliberately: a tab switch can leave this tab's OWN
  graph sitting under another tab's metadata residue (#817), which is
  indistinguishable from a foreign graph, so only the caller's comparison
  separates them.
  **This warns, it does not prevent.** Two stronger remedies were built and
  removed, and both are recorded in the code so they are not tried again. Refusing
  the open removes the repaint's root re-stamp — the one documented heal for a
  conflicting root tag — and strands every `graph_*` command, including the
  `panel_load_workflow` the refusal recommended, whose own error sends the caller
  back into the refusal. Auto-correcting from disk cannot be gated safely, because
  the tab's modified flag is wrong in both directions: it misses node-written
  values, and it stays spuriously set for the life of any tab the panel opened
  cold.

- **The same finding now rides a FAILING open too (#1089).** It was attached to the
  success reply only, so an open that also failed content verification dropped it —
  the worse combination, and the one #1111 reported: a mismatch WAS announced and
  the canvas was still the previous workflow's. The content warning says to re-read
  the graph; it did not say the state was another workflow's, which is the part
  that explains why the re-read looks plausible rather than alarming.

### Changed

- **Korean is complete — every panel string now has a translation (#1080).** The
  visible chrome had been left untranslated at 37% coverage; the connect-screen
  blurb, the effort label (which rendered its raw token rather than a name), and a
  set of strings no coverage metric could see are now wired.

## [0.14.15] - 2026-08-12

### Fixed

- **`panel_open_workflow` no longer claims a refresh it never performed (#1448).**
  The refusal said the file "isn't among the saved/open workflows even after a
  refresh" — for a file the reporter had confirmed on disk INSIDE that folder,
  twice. Both ways the refresh can fail to happen were silent: a frontend without
  `syncWorkflows` skipped it entirely, and a throw was swallowed by a
  `console.warn` no agent session reads. It now reports which actually occurred —
  list re-read, no sync method on this frontend, or re-read failed with the reason
  — and says outright that a skipped or failed re-read is NOT evidence the file is
  absent.
  Its remedy also stopped naming the wrong cause: "for a file outside the
  workflows folder" reads as a diagnosis, and sent someone away from a file that
  was exactly where they thought. `panel_load_workflow` is still offered, as a
  branch rather than a verdict.
  The refusal now also shows the selector SHAPES the store actually holds, which
  are not guessable from outside: `path` is `workflows/X.json`, `filename` carries
  NO extension, and `key` does.

## [0.14.14] - 2026-08-12

### Fixed

- **The panel now says WHICH tool vocabulary it vendored, at connect (#236).**
  The panel calls MCP tool names as bare string literals and validates them
  against a vendored copy of the vocabulary — which proves the literals match
  that copy, never that the copy matches the server it is talking to. When the
  two disagreed, the failure surfaced at call time as `unknown tool`, which
  reads as a broken panel and gives an agent nothing to act on.
  The hello now carries a hash of the vendored vocabulary, and the orchestrator
  compares it at connect (comfyui-mcp 0.51.13). A version string cannot do this
  job: two builds of one version can carry different vocabularies, and two
  versions can carry identical ones.
  Safe in both directions of skew — an orchestrator that predates the check
  ignores the field, and one that has it reads an ABSENT hash as unverified,
  never as disagreement.
- **Re-vendored the tool vocabulary.** The first live run of that handshake
  found real drift: the vendored copy was missing `panel_remove_widget`, 91
  panel tools against the server's 92. Found by the mechanism built for it
  rather than by someone hitting `unknown tool`.

## [0.14.13] - 2026-08-11

### Fixed

- **A numeric `from_output` no longer mints a junk rail slot named "4" (#1114).**
  Inside a subgraph, `panel_connect({ from_output: 4, ... })` replied `exposed`
  rather than `connected` and left a permanent rail input literally named `"4"`,
  visible on the parent subgraph node too. The rail lookup gated its index branch
  on `typeof ref === "number"`, but MCP argument coercion delivers `4` as the
  string `"4"` — so the lookup missed, and the caller read the miss as "no such
  slot" and created one. A lookup that failed closed would have been a refusal;
  this one edited the graph.
  The index parse is deliberately strict (`"04"` and `"007"` are names, not
  index 4 and 7), so a mistyped name cannot land silently on an unrelated slot.
  And when a ref matches BOTH a slot name and a different index — a rail whose
  slots are digit-named out of order — it now refuses and names both candidates
  instead of guessing, because nothing at that point can tell which was meant.

## [0.14.12] - 2026-08-11

### Fixed
- panel_screenshot stops throwing when a node has no type (#1115)
- an open that detects the wrong graph must refuse, not just say so (#1112)
- stop asking every run-to-node caller to report a permanent fallback (#1107)
- refuse a write to rgthree's Fast Groups toggle — it is a derived readout (#1106)
- a correction to an identical value is not a correction (#1104)
- warn when a direct write lands on a link-driven widget (#1102)
- name both ChatGPT routes, and stop the label map gating the handshake (#1100)
- a host probe must not shrink an authoritative provider list (#1094)
- don't capture another workflow's canvas into the tab being opened (#1092)
- resolve subgraph-qualified node ids instead of coercing them to NaN (#1090)
- rgthree seeds are invisible to the batch-repeat warning (#1082)
- core SaveGLB is addable — a 3D file union names formats nothing OUTPUTS (#1078)
- defect (2) — scope the #226 guard to the hazard it names (#1075)
- satisfy the tool-vocabulary gate, which this batch tripped four ways

### Changed
- 0.14.11 (#1113)
- 0.14.10 (#1109)
- 0.14.9 (#1105)
- 0.14.8 (#1103)
- 0.14.7 (#1101)
- 0.14.6 (#1099)
- 0.14.5 (#1093)
- 0.14.4 (#1091)
- 0.14.3 (#1086)
- 0.14.2 (#1081)
- 0.14.1 (#1076)
- 0.13.9 (#1072)


## [0.14.11] - 2026-08-11

### Fixed
- an open that detects the wrong graph must refuse, not just say so (#1112)
- stop asking every run-to-node caller to report a permanent fallback (#1107)
- refuse a write to rgthree's Fast Groups toggle — it is a derived readout (#1106)
- a correction to an identical value is not a correction (#1104)
- warn when a direct write lands on a link-driven widget (#1102)
- name both ChatGPT routes, and stop the label map gating the handshake (#1100)
- a host probe must not shrink an authoritative provider list (#1094)
- don't capture another workflow's canvas into the tab being opened (#1092)
- resolve subgraph-qualified node ids instead of coercing them to NaN (#1090)
- rgthree seeds are invisible to the batch-repeat warning (#1082)
- core SaveGLB is addable — a 3D file union names formats nothing OUTPUTS (#1078)
- defect (2) — scope the #226 guard to the hazard it names (#1075)
- satisfy the tool-vocabulary gate, which this batch tripped four ways

### Changed
- 0.14.10 (#1109)
- 0.14.9 (#1105)
- 0.14.8 (#1103)
- 0.14.7 (#1101)
- 0.14.6 (#1099)
- 0.14.5 (#1093)
- 0.14.4 (#1091)
- 0.14.3 (#1086)
- 0.14.2 (#1081)
- 0.14.1 (#1076)
- 0.13.9 (#1072)


## [0.14.10] - 2026-08-11

### Fixed
- stop asking every run-to-node caller to report a permanent fallback (#1107)
- refuse a write to rgthree's Fast Groups toggle — it is a derived readout (#1106)
- a correction to an identical value is not a correction (#1104)
- warn when a direct write lands on a link-driven widget (#1102)
- name both ChatGPT routes, and stop the label map gating the handshake (#1100)
- a host probe must not shrink an authoritative provider list (#1094)
- don't capture another workflow's canvas into the tab being opened (#1092)
- resolve subgraph-qualified node ids instead of coercing them to NaN (#1090)
- rgthree seeds are invisible to the batch-repeat warning (#1082)
- core SaveGLB is addable — a 3D file union names formats nothing OUTPUTS (#1078)
- defect (2) — scope the #226 guard to the hazard it names (#1075)
- satisfy the tool-vocabulary gate, which this batch tripped four ways

### Changed
- 0.14.9 (#1105)
- 0.14.8 (#1103)
- 0.14.7 (#1101)
- 0.14.6 (#1099)
- 0.14.5 (#1093)
- 0.14.4 (#1091)
- 0.14.3 (#1086)
- 0.14.2 (#1081)
- 0.14.1 (#1076)
- 0.13.9 (#1072)


## [0.14.9] - 2026-08-11

> #1085: adding an ImageCropV2 warned that this tab's node definitions were out of date and
> that a value had been replaced — showing the old and new values side by side, identical.

### Fixed
- adding a node no longer reports a value as "corrected" when nothing about it changed. The
  check compared values by identity rather than by content, and a value that is a group of
  numbers — like ImageCropV2's crop region — is a fresh group every time it is read, so it
  never matched itself. Every add of such a node raised the warning and told you to reload
  the tab.

### Changed
- values are now compared by what they contain, at any nesting depth. A value that genuinely
  changed is still corrected and still reported — that warning exists for a real case and it
  keeps working.
- anything the comparison cannot read faithfully is treated as changed rather than guessed
  at, which is what it did before. That is the safe direction: it can mention a correction
  that was not needed, but it will never stay silent about one that was.

## [0.14.8] - 2026-08-11

> #1087: setting a widget inside a subgraph reported success and changed nothing about the
> render — a run asked for 10 steps and sampled at 14, with nothing to indicate the value
> had been ignored.

### Fixed
- setting a widget that is fed by a connection now tells you it will not affect the render.
  When a subgraph promotes a widget to its outer node, the inner copy is driven by that
  connection and the outer value is what actually runs — so writing the inner one stored a
  number nothing reads. The write still happens (that inner value is the subgraph's stored
  default, and setting it is a reasonable thing to want), but the reply now says plainly that
  it will not change the output, and points at the outer node to set instead.

### Changed
- the check reuses exactly what the graph outline already shows for these widgets, so it
  reports the same connection the outline names rather than a second opinion.
- writing the widget on the OUTER subgraph node is unchanged and still the way to make it
  take effect — that path already updates both copies, and it does not warn.

## [0.14.7] - 2026-08-11

> #1084: the provider picker showed "ChatGPT" next to a lowercase "chatgpt", which looked
> like an accidental duplicate and gave you nothing to choose between.

### Fixed
- both ways of reaching ChatGPT are now named. They are genuinely different routes to the
  same subscription — **ChatGPT (Codex)** runs it through the Codex app-server, **ChatGPT
  (direct OAuth)** talks to it directly with no extra process — and only the first had a
  name, so the second showed its raw id.
- the panel now knows which provider it is connected to when you use the direct-OAuth route.
  This was the larger half: the panel decided whether a provider was "known" by whether it
  had a display name for it, so the unnamed one skipped the step that records the connection
  — leaving the remembered provider, the "Ask …" prompt and the highlighted chip all showing
  the previous one.

### Changed
- a provider your agent machine reports but this panel version has never heard of is now
  accepted rather than ignored, and shown under its own id until a release names it. New
  providers can land before the panel ships a label for them, and that ordering is normal.
- ComfyUI's Settings dropdown lists both routes too, so the default provider can be set to
  either.

## [0.14.6] - 2026-08-11

> #1083: connect to ChatGPT, reopen the model picker, and LM Studio, llama.cpp, Custom
> endpoint and Copilot are gone — with no way back to a Custom endpoint you had configured.

### Fixed
- the provider list no longer loses providers after connecting. The panel learns which
  providers exist from two places: the machine actually running your agents, which knows
  about all of them, and ComfyUI itself, which only knows a shorter built-in list. A routine
  background refresh from ComfyUI was replacing the full list with the short one, so
  everything past OpenRouter disappeared from the picker.

### Changed
- the shorter list is now merged into the fuller one instead of replacing it. A provider
  ComfyUI knows about but your agent machine did not mention is still added, and one it has
  stopped reporting can still go away — what it can no longer do is delete a provider the
  agent machine told us about.
- a provider's Running indicator still updates from those refreshes, so this does not trade
  a disappearing provider for one that looks permanently idle.
- the "(experimental)" marking and its terms-of-service warning on GitHub Copilot are now
  held back from those refreshes too, so a routine poll cannot quietly drop the warning.

## [0.14.5] - 2026-08-11

> #968: opening one workflow could silently give it a DIFFERENT workflow's graph — and
> every check said it was fine, honestly. This is the cause, found and fixed.

### Fixed
- switching to a workflow no longer copies the previous tab's graph into it. The panel
  switched tabs, then took a snapshot of the canvas, then repainted — and the snapshot ran
  while the canvas still showed the tab you were leaving. So the workflow you opened had the
  OTHER one's graph written into its unsaved state, was marked as edited, and was then
  repainted from exactly that. Every check afterwards compared the canvas to that state and
  agreed, because by then they genuinely matched. Only the file on disk disagreed, which is
  why reloading from disk was the one thing that fixed it.

### Changed
- the snapshot is now skipped when the canvas provably belongs to another workflow. When it
  provably belongs to the one being opened — the ordinary case, and the one the snapshot was
  added for — nothing changes at all.
- one case is knowingly not covered: a canvas the panel has never tagged cannot be attributed
  to anyone, so it is still snapshotted as before. Guessing there would mean either
  overwriting your live edits or writing the wrong graph, and neither is worth doing on a
  guess.


## [0.14.4] - 2026-08-11

### Fixed
- resolve subgraph-qualified node ids instead of coercing them to NaN (#1090)
- rgthree seeds are invisible to the batch-repeat warning (#1082)
- core SaveGLB is addable — a 3D file union names formats nothing OUTPUTS (#1078)
- defect (2) — scope the #226 guard to the hazard it names (#1075)
- satisfy the tool-vocabulary gate, which this batch tripped four ways

### Changed
- 0.14.3 (#1086)
- 0.14.2 (#1081)
- 0.14.1 (#1076)
- 0.13.9 (#1072)


## [0.14.3] - 2026-08-11

> #1339: a batch of ten came back as ten identical images, with nothing said about it. The
> warning that exists for exactly this looked for ComfyUI's own `control_after_generate`
> widget — and rgthree's Seed node DELETES that widget, so the most widely used custom seed
> node was invisible to it.

### Fixed

- a batch that will reuse one seed now says so when the seed comes from an rgthree Seed node.

### Changed

- it reports the thing that actually decides the outcome: whether the node is ARMED (its
  seed widget holding `-1`, `-2` or `-3`) or holds a concrete number that is submitted
  verbatim for every item. It stays quiet when the node genuinely varies — measured, an
  armed node gets a fresh seed per item even in a scoped batch, so the older warning's
  reasoning does not apply to it and is not reused.
- an armed node can still repeat when its `randomMin`/`randomMax` properties — or the seed
  widget's step — admit a single value. Measured over 200 draws, `min=0 max=5 step=100`
  returns ONE value while `min < max` looks perfectly healthy. That case is named too, with
  the remedy that fits it.
- a muted or bypassed seed node is not named, since it contributes nothing to the run.

### Notes

- your seeds are never rewritten. This says what will happen; it does not change your values.


## [0.14.2] - 2026-08-11

> #1062: asking the agent to add `SaveGLB` always failed. It is the only core node that
> writes a `.glb`, so while this was broken you could not build an image-to-3D or
> text-to-3D workflow through the panel at all.

### Fixed
- `SaveGLB` can be added again. Its `mesh` input accepts a list of 3D formats, and the panel
  refused to place the node unless it could prove every single one was a real connection
  type. Seven of the fourteen are formats ComfyUI can WRITE that nothing on your machine
  PRODUCES — so the proof could never be found, on any install, and retrying or refreshing
  the node list could not help. ComfyUI's core 3D file formats now count as connection
  types on their own.

### Changed
- the check that this relaxes is the one that stops a node being added when an input needs a
  widget that never loaded, so it was loosened narrowly and in one direction only: the list
  of 3D formats is a fixed set of the 13 ComfyUI ships, not a `FILE_3D_*` pattern. A custom
  node inventing its own `FILE_3D_…` type is still held to the same proof as before, and an
  input that asks for a real widget still waits for it.
- an input that names the widget it draws as (`widgetType`) is now correctly treated as a
  widget rather than a connection — a gap found while making the above safe, which could
  have let a node be added with neither a value nor a connection on a required input. Where
  that name is one of the four built-in kinds, it needs nothing loaded and no longer waits.


## [0.14.1] - 2026-08-11

> #1066, the other half: 0.13.9 stopped a URL-derived tab from building an unwritable
> `workflows/http://…/YourName.json`, but the tab still could not be saved. A second guard
> refused every name, because it could not prove what was on disk at the URL path — and
> nothing can. This is the fix that lets the tab save.

### Fixed
- a temporary tab whose path came from a URL now saves. The refusal came from a safety guard
  that protects against a save MOVING (destroying) the original file. That could happen when
  ComfyUI's `saveWorkflowAs` was the copy route — it moves a temporary rather than copying
  it. The panel stopped using it some time ago; the only relocating route left builds a new
  workflow in memory and writes that, never touching the source's file. So the guard now runs
  after the route is chosen and refuses only when no move-free route exists.

### Changed
- three separate attempts to prove such a source absent are recorded in #1066 as dead ends,
  because the trap is easy to fall into: the path shape (`://`) proves nothing — on Linux a
  real folder can legally be named `notes://draft`; the `isTemporary` flag proves nothing —
  real saved files can carry it after a load race; and ComfyUI's `/userdata` answers a
  URL-shaped path with a **500**, not a "not found", so the disk cannot answer either. The fix
  does not add a fourth attempt. It stops needing the proof.
- the "the original is gone" safety check now also runs for a source that could not be
  classified, which is the case with the least evidence and so the one that most needs
  checking afterwards. Its message now reports what was observed rather than blaming the save:
  two checks can prove a file DISAPPEARED, not who removed it.

### Notes
- your workflows are protected by the same rule as before — a save may never remove a file
  that exists. What changed is only where that rule can be broken, and the check that catches
  it if it ever is.


## [0.14.0] - 2026-08-11

> The panel shipped English-only while ComfyUI ships 12 languages, so setting ComfyUI to
> Korean gave you an English sidebar inside a Korean app.

### Added
- the panel, every sub-panel and its helper text are translated — roughly 1,000 strings.
  Korean, Simplified Chinese and Japanese are filled in; the other eight fall back to English
  per string until they are. The 52 rows in ComfyUI's own Settings dialog translate too.
- a **Panel language** setting: follow ComfyUI's language automatically, or pick one of the
  same 12 explicitly.
- Arabic and Persian lay out right-to-left, scoped to the panel so ComfyUI's canvas is
  untouched.

### Changed
- counts read correctly in every language. "1 model / 3 models" is an English rule; Korean has
  one form, Russian four, Arabic six, and the panel now uses each language's actual rules.

### Notes
- this entry was written after the fact — 0.14.0 shipped without one, which meant the panel's
  own changelog view had nothing to show for the release.


## [0.13.9] - 2026-08-11

> #1066: open an output image in ComfyUI and it mints a temporary workflow tab whose path is
> the URL the asset came from. Renaming that tab replaces only its filename — so the URL
> stays on as the tab's folder, and the tab could not be saved under ANY name.

### Fixed
- saving such a tab no longer builds `workflows/http://127.0.0.1:8188/api/YourName.json` and
  fails with a 500. A URL-shaped folder is recognised and the save is redirected to the
  workflows root, the same as any other unwritable location.

### Changed
- a URL-derived tab is deliberately NOT treated as an "external file". That classification
  drives a copy route whose whole premise is a real file on disk to copy — and a URL is not
  one, so treating it that way kept the tab unsaveable by a different path. This is why the
  reporter's own first successful save required treating the URL source as never persisted.
- one known cost, taken deliberately: on Linux/macOS a folder can legally be named with
  `://` in it, and a tab in such a folder now has its Save-As redirected to the workflows
  root. A redirected save is visible and recoverable; the 500 it replaces was not. Windows
  cannot hit this at all, since `:` is illegal in a filename there.


## [0.13.8] - 2026-08-11

> #968: three reports of the panel saying a tab was bound to the workflow you asked for
> while the canvas held a DIFFERENT workflow's graph — once queueing the wrong one. Every
> check reported healthy, and every check was telling the truth.

### Added
- `panel_open_workflow` on an already-open tab now compares the file it just read against
  the canvas, and says so when they share **no node ids at all**. In the report that was 44
  nodes on screen against 40 in the file with none in common — which is not what editing
  looks like.

### Changed
- it is a DISCLOSURE, not a refusal. Clearing a tab and rebuilding, or pasting a whole graph
  in before saving, look the same from here, so the note names those alternatives and leaves
  the judgement to you. A refusal built on that ambiguity would be a wrong-graph refusal of
  its own — the same class of harm as the bug.
- why nothing caught this before: the repaint loads from the tab's own state and proves the
  canvas against **that state**, while the staleness check compares the file against the
  tab's **baseline**. Both pass honestly when the tab's own state is carrying another
  workflow's graph. Nobody compared the file to the canvas, even though that code path had
  already read the file.


## [0.13.7] - 2026-08-11

> artokun/comfyui-mcp#938: an agent could WRITE a dynamic widget row and could delete the
> whole NODE, but had no way to delete one row — the add/remove affordance is a canvas-drawn
> button it cannot click.

### Added

- `graph_remove_widget` removes ONE dynamic widget row (rgthree Power Lora Loader `lora_N`,
  Impact/Inspire list rows). Undoable with Ctrl+Z.

### Fixed

- the remaining rows are NOT renumbered. `lora_N` is a monotonic id, not a position:
  `configure()` re-mints the names from serialized ORDER on every load, and the backend
  reads `**kwargs` filtered by name prefix, so gaps never reach it. The reply lists the
  remaining names, because an agent that assumed renumbering would address the wrong row.

### Changed

- removal is refused, with the specific reason, for an input the BACKEND declares (it would
  change what is sent at queue time), a frontend-generated control widget, a widget whose
  input slot currently has a link, and a subgraph container's promoted widgets. Node
  definitions that could not be READ are reported as unknown rather than treated as
  "declares nothing" — the difference between those two is the only thing separating a row
  from a KSampler's `steps`.

### Fixed
- a DUPLICATE delivery of a request the panel is already running no longer waits forever on
  it (#646). The command ledger marks a command in-flight and never evicts that entry —
  dropping an unsettled command would let a replay apply the same mutation twice — so an
  executor that never returned left every redelivery awaiting a promise that could not
  resolve, and the panel answered nothing at all. The duplicate now gets a real answer:
  still running, nothing was applied twice, do not retry, read the graph to see whether it
  took effect.
- that wait is bounded by the CALLER's own deadline, never by a number the panel invents. A
  fixed timeout is wrong in both directions — too high rescues nobody, too low reports
  "still running" for a command that was merely slow. The panel cannot see that deadline
  today, so absent it the behaviour is unchanged; this half activates when the orchestrator
  sends the timeout it already computes.


## [0.13.6] - 2026-08-11

> #968: three reports of the panel saying "bound to the requested workflow" while graph
> commands kept hitting the previous one — once queueing the wrong workflow outright. They
> have not converged because, after the fact, a stale binding and a fresh one look identical.

### Added
- a workflow-instance refusal now reports **what last moved the active workflow**, when
  anything did. If a panel command made the move it is named. If nothing claimed it, the
  refusal says so — and says plainly that this does NOT prove the panel was uninvolved,
  because not every command can register a claim. What it does establish either way is that
  a binding taken before that move is stale.

### Changed
- it decides nothing, deliberately. No refusal becomes an acceptance, and a refusal with no
  move to report is byte-for-byte what it was. Widening trust on an entry route nobody has
  identified is how a refusal turns into the silent wrong-graph edit this issue is about.
- ruled out along the way, and recorded on the issue: `panel_open_workflow` forces the canvas
  repaint itself and verifies it, both of its skip paths fail closed, and the report where
  the wrong workflow was queued ran on a build that already had both protections. So the
  binding is correct when it is made, and something re-points the tab afterwards.


## [0.13.5] - 2026-08-11

> #1369: `panel_add_node` applied a node definition's declared default over a widget's
> value whenever the two differed. For a COMBO whose option list does not CONTAIN that
> default, the "correction" wrote a value the node cannot accept — and reported success.

### Fixed

- a stale-schema "correction" no longer rewrites a valid COMBO widget to a value the node
  cannot accept (#1369). The live KJNodes def is
  `"sage_attention": [["disabled","auto",...], {"default": false}]` — the widget held a
  valid `"disabled"` and was overwritten with `false`.
- when a declared default is absent from that same definition's option list, the existing
  value is KEPT and the refusal recorded, rather than written and called a correction.

### Changed

- verified against this machine's live ComfyUI (4183 node types): of 1105 combo inputs
  carrying a default, 1083 corrections still apply and 22 are refused. The 22 are the
  reported KJNodes case plus model-filename defaults naming files not installed here,
  which ComfyUI's own `validate_inputs` would reject as well. No valid default was
  refused — the direction that would have quietly disabled the correction entirely.

## [0.13.4] - 2026-08-10

> #584: a ComfyUI tab that keeps running OLD panel JS after a reload, so the orchestrator
> sees a stale version and refuses graph writes. This is a backstop for hosts that leave the
> door open — not a cure, and the notes below say exactly which.

### Fixed
- the pack now gives its own `/extensions/comfyui-mcp-panel/` assets a cache policy on hosts
  that set none, matching the value current ComfyUI already applies to every extension.
  Older ComfyUI builds serve extension files with an ETag from mtime+size and no policy,
  which is the shape that lets a replaced file keep being served from cache.

### Changed
- **Measured before claiming**: ComfyUI 0.31.1 already sends `Cache-Control: no-store` for
  every `/extensions/` path, so on current builds this changes nothing. The staleness
  reproduced while developing 0.13.3 turned out not to be a cache at all — it was a reload
  cancelled by ComfyUI's unsaved-changes prompt.
- A first attempt used a weaker header and was described as a no-op. It was not: this pack's
  middleware runs INSIDE ComfyUI's own, so the host's `setdefault` preserved the weaker
  value and the panel's assets ended up with a LOOSER policy than every other pack's. The
  shipped version matches the host's value, so that inversion cannot happen.


## [0.13.3] - 2026-08-10

> #753: the panel's text was small and the obvious fix did nothing. Overriding
> `.cmcp-root { font-size }` scaled almost nothing, because every inner size was `rem` —
> resolved against the PAGE root, not the panel.

### Added
- **`--cmcp-fs`, one variable that scales the panel's text.** Set it on `:root` or
  `.cmcp-root` in a user stylesheet (default `0.8125rem`) and every panel font size follows,
  including the CivitAI explorer, the Apps tab and the modals. Measured: overriding it to
  1.5x moves 2110 of 2476 rendered elements by exactly that.
- It does NOT scale spacing, icons, or the handful of elements that carry a fixed pixel
  size, and the setting's tooltip now says so rather than promising more.

### Changed
- 214 inner font sizes became `calc(var(--cmcp-fs, 0.8125rem) * k)`, each reproducing its
  original pixel size at the default — verified element by element against a capture of the
  panel taken before the change, with no drift beyond sub-pixel rounding.
- The "Panel UI scale (%)" setting is unchanged and is still the way to scale the panel as a
  whole. Its tooltip used to explain why a stylesheet override could not work; that trap is
  gone, so it now names the knob that does.

### Fixed
- the status caret set its size through a JS assignment rather than a stylesheet rule, so it
  had been missed by every sweep. It scales with the rest now.


## [0.13.2] - 2026-08-10

> #945: the panel could not tell one workflow OBJECT from another without looking at the
> canvas — so two guards that decide whether an identity belongs to a copy were deciding
> nothing at all.

### Fixed
- a workflow that is not the one on screen can now be asked for its own identity (#945).
  The three fields that lookup used are absent on current ComfyUI, so it answered null
  every time, and both fork guards behind it short-circuited on their first line. It now
  falls back to the workflow's own captured state — but only for a workflow that is NOT
  mounted, and the reason for that restriction is the whole of this fix: for the workflow
  on screen, that field is a clone of the live canvas, so reading it there would answer
  "whose identity is this?" with "whatever is on screen", which is precisely what the
  caller asked it not to do.
- the mounted check compares identity the way the rest of the panel does, rather than with
  `===`. ComfyUI hands out reactive proxies in some places and raw objects in others, and
  the path that matters most here unwraps deliberately — measured on this machine, the
  active workflow IS a proxy whose raw target is a different object, so a strict comparison
  would have let the canvas back in with no race required.

### Changed
- where identity is WRITTEN is untouched. Embedding into the workflow's captured state
  moves where identity persists — it stops reaching the graph that a save serializes — and
  was reverted once for exactly that. Reading a field is not writing it.


## [0.13.1] - 2026-08-10

> The other half of #952. A question card whose connection was replaced already stopped
> looking answerable in 0.13.0; the command behind it, however, was left waiting forever.

### Fixed
- withdrawing an interactive card now ENDS the command behind it (#952). `panel_ask` and
  the secret request are the only commands whose executor blocks on a person, and retiring
  their card deliberately did not resolve its promise — so the executor stayed suspended,
  its entry in the command ledger stayed in flight, and entries in flight are never
  evicted, by design. Every withdrawn question kept a slot for the life of the tab and held
  the ledger's bound out of reach; a duplicate delivery of that request id then waited on a
  promise that could never resolve, and the panel answered nothing at all. Retirement now
  settles the command explicitly, as a failure that fabricates no answer.
- a payload-free failure for those two commands is no longer rewritten as "the panel
  collected the response, but the connection dropped" when nothing was collected. Replies
  that actually carry the person's own input are redacted exactly as before.

### Changed
- a correction to this project's own notes on #952, recorded because the plan rested on it:
  the orchestrator mints its session epoch once per PROCESS, so a tab reconnecting to the
  same process keeps its ledger scope. The earlier claim that a reconnect lands in a new
  scope and fails open into a duplicate card was wrong; that only happens across an
  orchestrator restart.


## [0.13.0] - 2026-08-10

> A panel connected to a ComfyUI the orchestrator cannot reach — a tunnel, a proxy URL, a
> loopback-only host — could not convert its own live canvas. Anything that pairs a captured
> graph with node definitions took the graph from the panel and the definitions from
> whatever COMFYUI_URL points at, which is the same machine locally and a different one
> remotely.

### Added
- the panel can now serve the node definitions of the ComfyUI it is actually looking at,
  fetched by the browser that is already talking to it (#1006). That is the panel half of
  the fix; the orchestrator side dispatches to it.
- the reply names which ComfyUI answered, and refuses rather than returning a partial
  schema — a conversion run on half a schema produces a wrong answer, not a smaller one.
- the payload is large (4183 node types on the machine this was built against), so a caller
  can pass back a fingerprint and be told the type set is unchanged instead of receiving it
  again. The reply says what that does not cover: a combo list or a widget name can change
  without changing which types exist.

### Fixed
- mark a question card whose connection dropped, instead of leaving two live ones (#952) (#1027)
- a created tab must leave a fence its own commands can pass (#1019) (#1025)
- report the provenance a catalogue answer can actually establish (#890) (#1023)
- Save-As must leave a fence the next command can pass (#978) (#1021)
- stop refusing a write for object_info that a reconnect never restored (#982) (#1018)
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.12.2 (#1028)
- 0.12.1 (#1026)
- 0.12.0 (#1024)
- 0.11.99 (#1022)
- 0.11.98 (#1020)
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.12.2] - 2026-08-10

> When the panel loses its connection while the agent is waiting on a question, the card
> stays on screen and stays clickable — but its answer can no longer reach anyone. If the
> agent asks again after reconnecting you get two identical questions, one of which does
> nothing, and until now the panel left you to work out which.

### Fixed
- a question card whose connection has been replaced is now visibly retired: its buttons
  stop working and it says the connection dropped and to answer the newer card (#952).
- the same for a secret request, with wording that never sends you to paste a token into
  the chat — that card exists so the value reaches the orchestrator through a masked input
  the agent never sees.
- a card is only retired when the connection that ASKED for it has actually been replaced.
  A reconnect that lands on the same socket, or a re-handshake (which happens routinely),
  leaves a live card alone — as does the Settings token field, which has no agent behind
  it and still works after a reconnect.
- a created tab must leave a fence its own commands can pass (#1019) (#1025)
- report the provenance a catalogue answer can actually establish (#890) (#1023)
- Save-As must leave a fence the next command can pass (#978) (#1021)
- stop refusing a write for object_info that a reconnect never restored (#982) (#1018)
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.12.1 (#1026)
- 0.12.0 (#1024)
- 0.11.99 (#1022)
- 0.11.98 (#1020)
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.12.1] - 2026-08-10

> When a command is refused because it targets a different workflow than the canvas, the
> panel offers two recoveries: re-target, or re-open the workflow you meant. For a tab that
> has never been saved — the one a fresh `panel_new_workflow` just made — the second is not
> available, because opening resolves a workflow by its path and that tab has none. A
> reporter had to work that out for themselves.

### Fixed
- the refusal now says so, when the panel can actually see it: the active tab is unsaved, so
  re-opening cannot re-select THAT tab, and re-targeting is the route if the canvas you want
  is the active one (#1019).
- the note is kept narrow on purpose. Opening a different, saved workflow still works — the
  refusal means the command targeted something other than the active canvas, and that
  something may well be a saved workflow the existing remedy reaches perfectly well.
- a saved tab reads exactly as before, and a tab the panel could not read says nothing at
  all: an unproven fact has no place in a refusal.
- report the provenance a catalogue answer can actually establish (#890) (#1023)
- Save-As must leave a fence the next command can pass (#978) (#1021)
- stop refusing a write for object_info that a reconnect never restored (#982) (#1018)
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.12.0 (#1024)
- 0.11.99 (#1022)
- 0.11.98 (#1020)
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.12.0] - 2026-08-10

> Searching for a custom node pack and getting "no matches" reads as "that pack does not
> exist". It can equally mean the list that was searched predates the pack: a machine whose
> network blocks the registry does not get an empty catalogue from ComfyUI-Manager, it gets
> a full one that may be months old, and nothing in the answer distinguishes the two.

### Fixed
- a node search that matches nothing now says how many packs it searched, that the request
  asked Manager for its cached copy, and — explicitly — that Manager does not report
  whether it honoured that, when the data was fetched, or whether it came from the network,
  the on-disk cache or the copy bundled with Manager (#890). So the result stops implying a
  pack does not exist when what it actually shows is that it was not in the list searched.
- the panel deliberately makes no guess about staleness. Measured on a working install, the
  served catalogue is not the bundled map (5583 packs against 4884, sharing about 1800
  entries), so the obvious "is this the bundled copy" test would never fire — it would ship
  as a check that always passes and quietly reassures.
- a search that finds something is unchanged, and an empty catalogue keeps its existing
  stronger answer: nothing was searched at all.
- Save-As must leave a fence the next command can pass (#978) (#1021)
- stop refusing a write for object_info that a reconnect never restored (#982) (#1018)
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.11.99 (#1022)
- 0.11.98 (#1020)
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.11.99] - 2026-08-10

> After a Save-As, graph tools could keep refusing even for an agent that did exactly what
> the reply told it to do. The reply said to re-target to the new workflow, and that clears
> one guard — but ComfyUI activates the saved copy without repainting the canvas, so the
> canvas is still showing the workflow you saved FROM. The second guard then refuses,
> correctly, and nothing said why.

### Fixed
- a Save-As reply now says that no canvas repaint was requested, and that re-targeting may
  therefore not be enough for graph tools: if a graph command is then refused for a
  root-workflow-uuid mismatch, that is the reason, and opening the saved workflow is what
  brings it onto the canvas (#978).
- the warning is stated conditionally rather than asserted, because a tab switch or a
  reconnect can repaint during the save — the panel knows the save did not ask for a
  repaint, not what the canvas holds by the time the reply is read.
- a FIRST save of an unsaved workflow no longer gets any of that: it keeps the same
  identity, nothing is about to be refused, and telling that caller to re-target and
  re-open would have sent them fixing a problem they do not have.
- stop refusing a write for object_info that a reconnect never restored (#982) (#1018)
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.11.98 (#1020)
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.11.98] - 2026-08-10

> A widget write could be refused for "object_info is unavailable — the backend is
> unreachable or the fetch failed" on a machine where ComfyUI was answering perfectly
> well. Two problems in one sentence: the panel had only one way to ask for the schema,
> and when that way failed it reported a cause it had never established. The reporter went
> checking a backend that was fine.

### Fixed
- a widget write no longer gives up when the frontend's own `getNodeDefs()` call fails —
  it asks the same question again over plain HTTP, which is the route that answers when
  the client does not (#982). Verified live: with the client made to throw, the fallback
  returned the full 4183-type schema on this install.
- the refusal now says what actually happened rather than naming a cause. It reports that
  no usable schema was obtained and lists what each route did, so a backend that answers
  by hand and a panel that cannot use it are told apart immediately.
- an EMPTY schema from the frontend client is treated as its answer, not as a failure to
  answer, so the fallback can never overrule a deliberate deny-all with a broader one.
  Everything else about the fence is unchanged: only a usable schema authorizes a write.
- the diagnostic text is bounded — control characters collapsed, per-entry length capped,
  at most four routes named with the remainder counted — because it comes from a backend
  or an extension and ends up in a message someone reads.
- a tab switch onto a MODIFIED workflow still refuses on a stale tag (#995) (#1016)
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.11.97 (#1017)
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.11.97] - 2026-08-10

> A workflow with unsaved edits could have every graph tool refused after a tab switch,
> including read-only ones, while the panel's own tab list confirmed the intended
> workflow active. ComfyUI reuses one canvas object across tabs and leaves the previous
> workflow's identity tag on it; the escape that handles that was written for a CLEAN tab
> only, and the report was filed on a modified one. Reproduced live through UI clicks:
> the canvas provably matched the active workflow and the panel refused anyway.

### Fixed
- a READ on a canvas whose content matches the active workflow's own state is no longer
  refused because the canvas carries the previous tab's identity tag, even when the
  workflow has unsaved edits (#995). Nothing is written: the tag is left exactly as it
  was, and the refusal is lifted for that one call.
- mutations are deliberately NOT included. Content equality against an edited tab's
  snapshot cannot say WHOSE canvas is mounted — two tabs can hold the same graph — and a
  write on that evidence could land on the wrong one. The bypass is opt-in, set in a
  single place for the commands classified read-only, so nothing else can acquire it by
  omission.
- an open workflow holding the same content as the canvas now blocks the bypass rather
  than being skipped as unprovable, since with edits allowed on both sides a twin would
  otherwise be invisible. Verified on the live install: a real twin blocked it, and with
  no twin present the read went through.
- stop a faithful workflow_open reporting CONTENT_UNVERIFIED and withholding the fence (#1001) (#1013)
- stop claiming a complete refresh that did not rehydrate anything (#981) (#1011)

### Changed
- 0.11.96 (#1015)
- 0.11.95 (#1012)


## [0.11.96] - 2026-08-10

> A report said the post-load compare in `workflow_open` was racing the frontend's
> normalisation. It is not a race. Sampling that compare at 0ms, one animation frame,
> 50ms, 250ms, 1s and 2s after the load resolved gave an identical answer every time — it
> is deterministic, and it fires for any workflow whose stored node sizes are not what
> this frontend computes. A perfect open was reported as unverified, and because that
> verdict throws, the open never published the workflow identity, so the NEXT command was
> refused too. The reporter needed four calls to reach a state the panel already believed
> it was in.

### Fixed
- an open that reproduced a workflow faithfully no longer reports its content unverified,
  and no longer withholds the workflow identity the following command needs (#1001).
  Content is proven when every node came back with the same id, type and serialized
  fields apart from node HEIGHT — the one thing the frontend was measured recomputing on
  load — with the width unchanged and both values readable numbers. Anything else,
  including a changed width, still refuses.
- the same compare reported a phantom difference on every node of every saved workflow.
  The frontend stamps `showAdvanced` on each node it instantiates with the value
  `undefined`, which no saved file can carry because JSON drops it. A key present with
  `undefined` now reads as absent; a key present as `null` still counts, since JSON does
  carry null and a nulled widget value is a real loss.
- when an open proves content that way, the reply says so — which field differed, that
  every difference was a height, and that the panel observed the difference rather than
  its cause. Saving from there writes the recomputed value, which is now stated rather
  than left to be discovered.

### Changed
- 0.11.95 (#1012)


## [0.11.95] - 2026-08-10

> `panel_refresh_nodes` said `{ok:true, refreshed:true}` while `panel_get_errors` kept
> listing the same classes as missing, after the packs were installed and ComfyUI was
> restarted. Both answers were right, which is why neither helped: the definitions really
> were re-fetched, and the nodes really were still broken. Measured on the running
> install — registering a class does not rehydrate a node that was placed while the class
> was unknown. It keeps no definition, and the frontend's missing-node record is a
> load-time snapshot nothing ever clears. Clearing that snapshot would have been the
> obvious fix and the wrong one: `get_errors` would report clean while the canvas still
> held a dead node. The refresh now reports what it actually left behind.

### Fixed
- a refresh that leaves placeholders behind now says so, instead of reporting a clean
  result the canvas contradicts (#981). The reply carries `requires_reload`, the affected
  nodes, and a note that names the remedy — save the workflow, then reopen that saved
  workflow — and is explicit that this is an attempt rather than a guarantee, since a
  class present in the registry can still fail to construct. Verified live, on a canvas
  where exactly that happened.
- the first version of this check reported four false positives — `Note`, `Reroute`,
  `PrimitiveNode` and `MarkdownNote` all lack a backend definition, so a canvas with a
  single Note on it would have demanded a workflow reload after every refresh. The scan
  is now confined to types the frontend itself recorded as missing when the workflow
  loaded, and asks the client registry rather than `/object_info`: the server having a
  definition is not the same as this page being able to build the node.


## [0.11.94] - 2026-08-10

> Covers changes since 0.11.93.

### Added

- **"Run to node" with a batch now warns that your seed will not change (#988).**
  Someone ran `panel_run` with `to_node_id` and `batch_count: 3` on a workflow whose
  KSampler was set to randomize. Three prompts were accepted; the first took 22
  seconds and the rest finished in about a fifth of a second, returning the same file
  and the same image.

  Every item used the same seed. Measured by comparing the actual requests: an
  unscoped batch of three sends three different seeds, and a scoped batch of three
  sends the same seed three times. ComfyUI does not advance `control_after_generate`
  between the items of a *partial* execution — which is what running to a node is —
  so the later prompts are duplicates it answers from cache. Checked in both of
  ComfyUI's widget-control modes, and it happens in both.

  The panel now says so when you queue that combination: which controls will repeat,
  why, and the two things that do work — `batch_count: 1` several times setting the
  value yourself, or dropping `to_node_id` so the run is unscoped.

  **It does not silently change your seeds.** Doing that would mean re-implementing
  ComfyUI's own widget behaviour — randomize, increment and decrement all differ, each
  with its own range — on the one path where the panel already has to patch the
  request. The warning also says what it cannot know: it lists every such control in
  the workflow, because it cannot tell which ones a scoped run actually reaches.


## [0.11.93] - 2026-08-10

> Covers changes since 0.11.92.

### Added

- **A repeated render result now says so (#986).** Someone had the same finished clip
  announced to the agent six times in about thirty seconds — each with a different
  prompt id, each with a "render time" of a tenth of a second against a first render
  that had taken almost eleven minutes. Every one asked the agent to respond, and
  nothing told it these were the same file it had already reviewed.

  They were separate prompts, because the runs were re-queued from the canvas and
  ComfyUI answered each from its cache. The panel's existing check compares prompt
  ids, so it had nothing to match on. It now also compares what the run actually
  produced: a completion whose output files were already delivered says which earlier
  run delivered them, and whether it finished too fast to have rendered anything.

  **Nothing is held back.** An earlier version of this suppressed the repeats
  outright, and that turned out not to be safe — a node that writes to a fixed
  filename can produce a genuinely different result in under a second, and there is no
  way to tell that apart from a cached replay. Withholding a render you waited for is
  worse than an extra message, so every completion still arrives; it just arrives
  labelled.

  The label is careful about what it knows: the panel compares file *references*, not
  file contents, and says so, and it does not claim a run did real work when all it can
  see is that the run was not suspiciously fast.


## [0.11.92] - 2026-08-10

> Covers changes since 0.11.91.

### Fixed

- **Unpacking a subgraph no longer throws away the values you set on it (#979).**
  Someone unpacked a subgraph and got the pack's template prompt back instead of the
  long custom one they had written, and a duration of 2 instead of the 15 they had
  set. Model and VAE choices survived; the values they had actually typed did not.

  When a widget is promoted to the outside of a subgraph, the value you see on the
  parent is the one that renders. Unpacking inlined the **inner** node's value
  instead — usually whatever the pack shipped as a default. Since unpacking is
  destructive, the parent's value was gone at that point, and the only fix was
  remembering what it had been and typing it back.

  The values are now carried inward before the subgraph is taken apart, and the
  result says which ones moved.

  The rest of this change is about what happens when that carry goes wrong. Custom
  nodes can do arbitrary things when a widget is written — clamp the value, throw
  halfway, change something else on the node. If any of that happens, the panel now
  **restores the workflow and refuses to unpack**, rather than pulling the subgraph
  apart around a value it cannot account for. Refusing leaves everything intact and
  recoverable; guessing would not.


## [0.11.91] - 2026-08-10

> Covers changes since 0.11.90.

### Changed

- **"Run to node" falling back to a request repair now tells you a version that
  works (#996).** When the panel runs a single branch, it asks ComfyUI to scope the
  run. On some frontend builds that request never carries the scope, so the panel
  writes it into the request itself and says so — a fallback that works, but one the
  message asked you to report while giving you nothing to compare against.

  It now carries one measured fact: on **ComfyUI frontend 1.48.7** the scope does
  reach the request, so the fallback is not expected there and trying that build may
  be the quickest workaround. That was established by capturing the outgoing request
  on 1.48.7 — which shows the request is built correctly, not that a whole run
  behaves differently, and the message says so rather than implying more.

  It still does **not** claim which builds are affected. That is one build measured;
  turning it into a version range would repeat a mistake this file has made before,
  when a range covering builds nobody had tested told three reporters their own
  evidence could not be happening.


## [0.11.90] - 2026-08-10

> Covers changes since 0.11.89.

### Added

- **`panel_run` now warns when your workflow has outputs inside a muted subgraph that
  will render anyway (#985).** Someone ran a workflow with one active source subgraph
  and two muted ones. All three rendered — Wan, LTXV and MiniMax H3 loaded in turn,
  three videos saved, 18 minutes 44 seconds — and the run reported plain success.

  The cause is not in this panel, and the fix cannot be either. ComfyUI applies a
  subgraph's mute/bypass **only at the top level of a workflow**. Mute a subgraph
  that sits inside another subgraph and it is ignored: everything in it still runs.
  A whole-workflow run hands prompt building to ComfyUI, so pressing ComfyUI's own
  Queue button does exactly the same thing. Measured on ComfyUI 0.31.1 with frontend
  1.48.7, for mute and bypass alike.

  What the panel can stop doing is being quiet about it. A whole-workflow run now
  names the output nodes that sit inside a nested muted or bypassed subgraph, in the
  one-line summary as well as the full result, so you can interrupt instead of
  finding out when the renders land. Running to a specific output node
  (`to_node_id`) scopes execution correctly and is the way to render just the branch
  you want.

  Two things it deliberately does **not** do. It does not change what executes —
  quietly dropping nodes from a run you asked for would be its own kind of wrong. And
  it does not claim to know your ComfyUI version: the warning is read from your
  workflow's structure, so on a build that handles nested subgraphs properly it will
  warn about a run that was fine. The message says so, and tells you how to check.
  Muting a **top-level** subgraph — the ordinary way to switch a branch off — is
  silent, because that one genuinely works.


## [0.11.89] - 2026-08-10

> Covers changes since 0.11.88.

### Fixed

- **`panel_get_errors` no longer reports a problem and "no errors" in the same
  answer (#984).** The panel has two ways of finding a widget that names a file the
  server does not have: the snapshot ComfyUI takes when a workflow loads, and a live
  check against the server's current node list. The live one was added later, and the
  "no errors recorded" verdict was never taught about it — so a defect only the live
  check could see was reported in the payload while the summary said
  `Checked errors — none`.

  The case that shows it: a `CheckpointLoader` whose `config_name` names a
  `models/configs` file that is not there. No missing-**model** tracking covers that
  folder, so the load-time snapshot has nothing, and the live check is the only one
  that knows. Both halves now decide the verdict together.

  Two related corrections came out of reviewing it:

  - **The same missing file is no longer counted twice.** Both halves usually find
    it, and the summary was adding the lists — reporting six problems where there
    were three.
  - **A widget that is driven by a connection is no longer judged on its own value.**
    When you convert a widget to an input and connect something, ComfyUI keeps the
    widget around and runs the connection instead; its leftover value is often stale.
    Checking it reported an error on a workflow that runs perfectly well.

  Worth saying plainly for anyone who filed something like this: if `panel_get_errors`
  reports clean while your canvas shows red loaders, this fix may not be your problem.
  The originally reported shape did not reproduce — with loaders naming absent files,
  including subfolder-qualified ones with backslashes, every layer detected them
  correctly. A tool refusal in the same report pointed at a stale panel bundle in the
  browser instead, for which the remedy is a hard refresh.


## [0.11.88] - 2026-08-10

> Covers changes since 0.11.87.

### Fixed

- **A widget write that a node's own callback breaks no longer reads as the panel
  failing (#976).** `panel_set_widget` would apply your value, verify by read-back that
  it was in effect, refuse to roll it back — and then say "an exception was thrown while
  applying the write". Which reads as *the panel failed to apply your write*. It is the
  opposite of what happened, and it is why this was reported as a panel defect.

  The reporter's node was `MiniMaxH3Director`, but the same message appears on a stock
  `CLIPTextEncode` whose callback is made to throw, so nothing about it was specific to
  that pack.

  The wording named nothing on purpose. A widget write touches value setters on the
  widget, the promoted rail and the display proxies; it reads properties that can be
  throwing accessors; and assigning to a frozen widget throws with no node code involved
  at all. Blaming "the callback" for any of those would be a guess.

  So the panel now measures it instead of guessing. The callback is looked up and its
  arguments are evaluated before the attributed step begins, and only an exception coming
  out of the attempt to invoke it is attributed — which is why the disclosure says
  "attempt to invoke" and never that the callback ran: a value that is not a function, a
  class, and a revoked proxy all throw without any code of theirs executing. When the
  callback is not a function at all, it says that outright.

  It does not go further than that. It does not say who supplied the callback, and it
  does not assign fault: the panel invokes callbacks programmatically, and that alone is
  enough to make a callback written for a mouse click throw. What it does say, first, is
  that your value is in effect.

  Two things found on the way, both of which could hide a real problem:

  - a callback doing `throw undefined` (or `null`, `0`, `""`) produced **no warning at
    all** — the write reported clean while the callback's side effects had not run
  - a thrown value that fights back (a proxy whose `message` and prototype both throw)
    could break the report that exists to disclose it, losing the failure entirely

### Changed

- Documentation corrections to two binding claims and a run-scope build range (#970,
  #752), and e2e cleanup that no longer leaves saved workflows behind or passes against
  the wrong orchestrator (#907, #847).


## [0.11.87] - 2026-08-09

### Fixed
- **A failed install by git URL now points at the tool that can actually do it (#920).**
  When you install a pack that is not in the node registry, ComfyUI-Manager cannot clone
  your URL — it resolves installs from its own database, and the parameter that would
  carry a URL is accepted and then ignored. The failure now tells you to use
  `install_custom_node` instead: that one runs on the machine rather than in the browser,
  so it clones the repository into `custom_nodes/` itself.

  Worth saying explicitly because `panel_install_node`'s own description tells you to
  prefer it over `install_custom_node` — which is backwards for this case, and following
  it leaves you stuck. The message now says the preference does not apply here, and notes
  where the fallback cannot help either: a remote ComfyUI has no local tree to clone into.


## [0.11.86] - 2026-08-09

> Covers changes since 0.11.85.

### Changed

- **Editing many widgets in a row is no longer slow (#716).** Every `panel_set_widget`
  re-downloaded ComfyUI's entire node schema before writing — on an install with 63 custom
  node packs that is 5.4 MB and roughly 170 ms, every single time. A prompt-editing task
  that touched 29 widgets paid for it 29 times.

  A burst of writes now shares one download instead of taking one each. Measured on the
  test rig: 12 widget writes went from 12 downloads to 1.

  The safety check those downloads exist for is unchanged. A write is still authorised
  against the live backend's node list, and that list is re-read the moment anything the
  panel can see could have changed it — a node refresh, an install, a completed download,
  or a reconnect. The one case it cannot see is a pack uninstalled through ComfyUI's own
  Manager while an agent is mid-edit, which leaves a window of up to 1.5 seconds; that is
  written down in the code rather than left for someone to discover.

### Fixed

- **A changelog entry no longer repeats a release that already shipped.** Version tags here
  lag the releases themselves, and the generator preferred the newest tag over the newest
  release commit — so with `v0.11.84` tagged and 0.11.85 untagged, this entry initially
  re-listed a fix 0.11.85 had already announced. It now takes whichever of the two is
  actually newer, decided by ancestry rather than by date.


## [0.11.85] - 2026-08-09

> Covers changes since 0.11.84.

### Fixed

- **A refresh that lands while ComfyUI is reconnecting no longer reports a dead server
  (#954).** Calling `panel_refresh_nodes` just after a restart-related operation could come
  back `object_info_fetch_failed` — "Failed to fetch" — while other reads succeeded moments
  later against the same server. Worse than the false failure was its advice: it told you to
  check that the ComfyUI process was still running, sending you after something that was
  never down.

  The fetch now retries three times over about half a second before giving up, which is
  enough to cross a reconnect blip. The panel already did this at startup, so the same
  hiccup was survivable when the page loaded and fatal to an agent tool call a minute later.
  A backend that really is gone still reports exactly what it reported before, with the same
  detail — a retry that turned a real outage into a vaguer message would trade one wrong
  answer for another.


## [0.11.84] - 2026-08-09

_No user-facing changes._


## [0.11.83] - 2026-08-09

> Covers changes since 0.11.82.

### Added

- **The panel now tells you what changed when it updates under you (#758).** It installs
  from the Comfy Registry and the orchestrator runs the latest agent, so the version can
  move without you asking — and the first sign was usually something behaving differently
  than you remembered, which reads as a bug rather than a release.

  On the first load after an update the transcript shows what shipped between the version
  this browser last saw and this one, each line tagged Added, Fixed or Changed. That
  distinction is the point: "this used to work differently on purpose" is a different
  message from "this was broken". It appears once, says nothing on a fresh install, and
  says nothing if you roll back.

  Settings → Comfy MCP Agent → About → **Show what is new** re-opens it whenever you want,
  since a line in a transcript scrolls away and the request was for somewhere to look.

### Fixed

- **A failed install by git URL now says what is actually wrong (#920).** Passing a
  repository URL for a pack that is not in the node registry failed with
  *"Node '<name>@<version>' not found in [...]"* — a registry lookup naming an id you never
  supplied, which reads like a lookup bug and sends you to re-check spelling and channels.
  It now explains that this is a registry lookup, that ComfyUI-Manager's `repository`
  parameter is accepted and then ignored by its install handler, and what does work: clone
  into `custom_nodes/` and restart, ask the author to publish, or — two steps, not one —
  run with `--enable-manager-legacy-ui` (which *replaces* the v2 Manager API) **and** set
  `allow_git_url_install = true` in `config.ini`, without which that route answers 404.

  Also **corrects the 0.11.75 entry**, which claimed installing from a GitHub URL "actually
  clones it now". It does not, and that entry now says so.

## [0.11.82] - 2026-08-09

> Covers changes since 0.11.81.

### Added

- **`panel_open_workflow` now reports which workflow it observed to be active, beside the
  one that was requested (refs #887).** The reply named only the target, so a caller could
  not tell "the requested workflow is active" from "the requested workflow is what you
  asked for" — and a Save-As taken on that reading writes the live canvas, which may be a
  different workflow. The reply carries `active_routing_key` and `active_matches_target`
  (true, false, or null when it could not be read), with a warning when they disagree.

  This is groundwork, not the fix: the contradictory "you are NOT on the wrong workflow"
  message is composed by the orchestrator, which does not read these fields yet, so nothing
  user-visible changes until it does. #887 stays open.

## [0.11.81] - 2026-08-09

> Covers changes since 0.11.80.

### Fixed

- **A Save-As no longer strands the agent that performed it (#941).** `panel_save_workflow`
  with a new name writes the copy and switches the active canvas to it — which fences the
  very session that asked for the save, so every following `panel_*` graph call is refused.
  That is survivable only if the reply says what to re-fence to, and it did not: it reported
  the identity as unavailable, while the next call was refused *using* an identity the panel
  had declined to publish one call earlier.

  The identity read is deliberately pure — a fence refreshed from a value a read invented
  would be agreeing with itself rather than observing anything — and a Save-As activates a
  brand-new object nothing had established an identity for. So the read honestly found
  nothing while the fence, whose own read mints, immediately found one. The identity is now
  established as part of the save, from the record the save itself produced and proved
  active, never from a later look at whichever canvas happens to be current. A Save-As that
  cannot produce one still reports absence rather than substituting a different canvas.

- Name the canvas swap point, from the canvas-rebuild side (#944).


## [0.11.80] - 2026-08-09

> Covers changes since 0.11.79.

### Fixed

- **Your first chat about a workflow no longer disappears when you filter to that
  workflow (#847).** Chat, start a second chat, then tick "Current workflow only": the
  first conversation vanished, even though both were held on the same canvas.

  The panel saves an unsaved workflow before a turn ("grounding", #330), and ComfyUI
  replaces the workflow object at that save. Every carrier that could hand the identity
  to the successor is empty at that instant — the object maps are keyed on the object
  that just went away, the embedded uuid is unreadable because the fields it is looked
  for in are all absent on this frontend, and the path alias gets written from the new
  id. So the successor minted a fresh identity and the conversation from seconds earlier
  was left holding one that nothing answered to.

  The tab's pre-save route id is now captured *inside* the grounding transaction and
  filed under the path that save produced. That location matters: an observer watching
  the change afterwards cannot prove the old id was this tab's past rather than a
  workflow you switched away from, which is why the panel deliberately migrates nothing
  there. The save knows by causation — it is the panel's own call, on its own active
  workflow — so nothing is inferred.

  Scope is small on purpose: these forms are consulted by the history filter alone.
  They never resolve a workflow's identity, authorize a graph write, or restore a
  session. One limit stays open and is documented rather than hidden — deleting a
  workflow and creating a new one with the same name can show the old chats under the
  new one, since a path is not proof of ownership.


## [0.11.79] - 2026-08-09

> Covers changes since 0.11.78.

### Fixed

- **The e2e suite stops leaving saved workflows in your library, and says so when it
  cannot be sure (#907).** Specs that persist a workflow were leaving the file behind:
  1272 of 1288 files in the dev workflow directory were test output. Per-spec cleanup
  could not fix it, because it sat at the end of a test body and so never ran when a
  test failed. Cleanup is now suite-level, and deletes only files that appeared during
  the run AND carry the suite's own name prefix — ComfyUI names an unnamed save
  `Untitled <date> <time>`, which is exactly what it names YOURS, so nothing keyed on
  that name is safe to delete automatically. Anything else that appears is reported by
  name rather than removed or ignored. Developer-facing only; nothing in the shipped
  panel changes.

## [0.11.78] - 2026-08-09

> Covers changes since 0.11.77.

### Fixed

- **A tab now measures its own module cache instead of asking you to open DevTools
  (#584).** This issue has had five fixes and keeps coming back, because each was built
  on a hypothesis about the browser cache that nobody had measured — and the only way to
  measure it was to ask someone whose tab was already wedged to read their Network tab.
  The panel now reports, per module, whether it came from the server, from cache, or via
  a 304 revalidation, and says so when the version check reads healthy but the modules
  did not. That branch used to return silently, which is the shape this issue keeps
  returning with: one version constant looking fine while the page it belongs to does
  not behave like it. A healthy load stays silent. The same summary goes into the
  diagnostics you copy into an issue, so the next report arrives with the measurement
  already in it.

## [0.11.77] - 2026-08-09

> Covers changes since 0.11.76. The first entry this generator produced correctly.

### Fixed

- **Generating a changelog no longer replays the entire history into one release
  (#932).** Every entry was built from the first commit onward, so a release claimed
  ~200 commits of already-shipped work as its own. Both release matchers had been
  written for commit shapes this repo has never produced: the base search grepped for
  `release:` / `chore(release):`, which matched nothing and fell through to
  `rev-list --max-parents=0` — the root commit — and the predicate that keeps release
  commits *out* of an entry required the version to be the whole subject, so releases
  were written into the entries announcing them. Releases here read
  `0.11.76 — <description> (#930) (#931)`, and now both rules key on a version at the
  start of the subject.

  The fix is deliberately not a `git log --grep`. `--grep` searches the whole commit
  message and matches per line, so `^<version>` also fires on a *body* line — in this
  repo's own history it selects 7521519, an ordinary `fix(subgraph):` commit, which
  would have anchored a release on itself and silently truncated the entry. Subjects
  are read from `%s` and matched in JS, by the same predicate the generator already
  used, so there is one rule rather than two that can drift.

  This was worked around by hand for all fourteen releases from 0.11.63 to 0.11.76.
  A silent workaround is how a broken tool survives that long.


## [0.11.76] - 2026-08-09

> Covers changes since 0.11.75.

### Fixed

- **A subgraph boundary rail is no longer reported as a node that doesn't exist
  (comfyui-mcp#1294).** `panel_query_graph` hands out a subgraph's rails as
  `rails.output.rail_node_id: "-20"`. Passing that back to an edit answered *"No node with
  id -20 in the current graph … The id may be from a different workflow, or the node was
  removed. Re-read with panel_graph_outline before retrying."* Every clause after the
  first was false — the id came from that graph, from the panel's own read, one call
  earlier — and the remedy re-read the surface that produced it, so following it looped.
  The failure now names what the id actually is, notes that `panel_move_node` takes a rail
  id (position only) while `panel_move_rail` addresses it by side, and says plainly that
  no unexpose operation exists rather than implying one.

## [0.11.75] - 2026-08-10

> Covers changes since 0.11.74.

### Fixed

- **The install request now carries your repository URL (#920).** The panel used to reduce
  a GitHub URL to just the repo's name and throw the rest away; it now sends the URL in the
  `repository` field ComfyUI-Manager's API declares for it.

  **This does not yet make such an install succeed, and this entry originally said it did —
  that was wrong.** ComfyUI-Manager v4's v2 install handler accepts the field and then ignores it: it
  reads only `id`, `selected_version`, `channel`, `mode` and `skip_post_install`,
  and resolves the clone URL from its own database instead. A pack that is not in the
  registry still cannot be installed by URL on a stock v4, and you will still see
  *"Node '<name>@<version>' not found in [...]"*.

  The change is kept because it is what the documented API asks for and it will start
  working if Manager implements the field — but it is forward-compatibility, not a fix.

  What works today for an unlisted pack, least effort first: `git clone` into
  `custom_nodes/` and restart, or ask the pack author to publish to the registry. There is
  a legacy git-URL route, but reaching it takes two steps — `--enable-manager-legacy-ui`
  (which *replaces* the v2 Manager API rather than adding to it) **and**
  `allow_git_url_install = true` in ComfyUI-Manager's `config.ini`; an unlisted pack is
  rated "high+" risk and without that setting the route answers 404. Tracking in #920.

## [0.11.74] - 2026-08-09

> Covers changes since 0.11.73.

### Fixed

- **Saving a subgraph over a built-in name no longer sends you looking for a delete
  button that isn't there (#636).** When the name clashes, the panel refuses and suggests
  deleting the existing one from ComfyUI's library. But ComfyUI won't delete the
  subgraphs it ships with — and on a stock install nearly all of them are its own, so the
  clash you're most likely to hit is the one where that advice can't be followed.

  It now recognises a built-in and says the name can't be freed, so the only thing left is
  to pick a different one. Clashes with a subgraph you saved yourself still suggest
  deleting it, and so does any case where the panel can't tell — withholding an option
  that might work is worse than offering one you'd rule out in seconds.

## [0.11.73] - 2026-08-09

> Covers changes since 0.11.72.

### Fixed

- **The saved-subgraph list no longer claims every blueprint is yours (#636).** Listing
  saved subgraphs reported `is_global: false` for all of them — including the ones
  ComfyUI ships — because it read a property blueprints do not have. The agent had no way
  to tell a bundled subgraph from one you saved.

  It now asks ComfyUI, using the same call ComfyUI's own library menu uses. Where that
  answer can't be trusted — an older frontend, or one that names blueprints in a shape
  the panel doesn't recognise — the field is `null` rather than a guess. "I can't tell"
  and "this one is yours" are different answers, and reporting the second in place of the
  first is exactly what was wrong before.

## [0.11.72] - 2026-08-09

> Covers changes since 0.11.71.

### Fixed

- **You can add a saved subgraph by the name you see in the library (#636).** Asking for
  one by its name failed with *"No saved subgraph blueprint"*, because current ComfyUI
  stores them under a generated id and the panel only looked for that. The name shown in
  the library — the only one you'd think to use — was the one thing that didn't work,
  while the unreadable id did.

  It now accepts either. The id is still tried first, so nothing that already worked
  changes.

  If two saved subgraphs share the same library name, it says so and asks for the id
  instead of picking one. Adding the wrong graph quietly is worse than being asked to be
  specific. And if the lookup itself fails, the error says that rather than claiming you
  never saved it.

  Same cause as the name-clash fix in 0.11.71. Updating an existing saved subgraph is
  still not possible from the agent — that part of the report remains open.

## [0.11.71] - 2026-08-09

> Covers changes since 0.11.70.

### Fixed

- **Saving a subgraph under a name you've already used is caught again (#636).** The
  panel refuses to save a reusable subgraph over an existing one, because replacing it
  needs ComfyUI's own confirmation dialog — which an agent has no way to answer. On
  current ComfyUI that check had stopped working: blueprints are now stored under a
  generated id rather than the name you gave them, so the panel was comparing your name
  against an id it could never equal, and saw no clash at all.

  It now also compares the name shown in the library, which is where your name actually
  lives. Older ComfyUI versions that store blueprints by name are unaffected, and a
  different subgraph is still not treated as a clash.

  Updating an existing saved subgraph is still not possible from the agent — that half
  of the report is open.

## [0.11.70] - 2026-08-09

> Covers changes since 0.11.69.

### Fixed

- **A video your browser can't play now says so instead of showing a blank card (#909).**
  Asking the agent to show a video reported success and displayed nothing, because the
  tool answers for handing the video to the page — not for whether the browser could
  actually decode it. An MP4 in an older format (MPEG-4 Part 2) is the reported case.

  The card now says the format can't be played and suggests re-encoding as H.264 or
  WebM, instead of leaving you to guess whether the video is broken, still loading, or
  never arrived.

  Two things it deliberately does not do: it does not report a failure when a working
  video is simply scrolled out of view (tearing one down looks identical to a decode
  error from the outside), and it does not keep retrying media it has already failed on,
  which would make the message flicker away each time you scrolled back.

## [0.11.69] - 2026-08-09

> Covers changes since 0.11.68.

### Security

- **A workflow you open can no longer lie to the agent about your graph (#904).** The
  graph outline the agent reads marks nodes with short status tags — `[bypass]` and
  `[mute]` mean a node isn't running, `[after_gen=randomize]` means ComfyUI quietly
  changes that value on every run. Node titles and widget values were written into that
  same text as-is, so text containing one of those tags was indistinguishable from a tag
  the panel had actually emitted.

  This is reachable by **workflows you download**, not just by what you type: a prompt in
  a shared JSON could make the agent believe a node was disabled, or that a value was
  being rewritten behind its back, and act on it.

  Values are not censored to fix it — bracket syntax like `[cat|dog]` is ordinary prompt
  content, and deleting it would corrupt what you asked to see. Instead a value
  containing brackets is now quoted, so a tag outside quotes is always the panel's own.
  Ordinary values are unchanged. Titles, which were already quoted, can no longer end
  their own quoting early.

  Found while fixing #636 and verified against a live ComfyUI before and after.

## [0.11.68] - 2026-08-09

> Covers changes since 0.11.67.

### Fixed

- **The graph outline now shows widgets you've renamed (#636).** If you rename a
  subgraph's promoted widgets, the canvas shows your new names — but the outline the
  agent reads kept listing the original keys. One user was told their renames "hadn't
  stuck" when they plainly had, and only a screenshot settled it.

  The detailed reader was fixed for this in 0.11.42. The outline — the quick overview an
  agent reaches for first — was not, so the misleading answer was still one call away. It
  now shows both: `width=512 [renamed "Frame Width"]`. The original name stays first,
  because that is the one you use to set the value; the name you gave it rides alongside.

  Only renamed widgets are annotated, so an ordinary graph's outline is unchanged.

### Security

- **A renamed widget can no longer forge a status tag in the outline (#636).** The outline
  is written for the agent to read, and marks widgets with tags like
  `[after_gen=randomize]` — which means ComfyUI silently rewrites that value on every run.
  Because widget names are yours to choose, a name containing the right punctuation could
  close its own tag and invent one of those, describing behaviour the node does not have.
  Names are now escaped so they cannot break out.

## [0.11.67] - 2026-08-09

> Covers changes since 0.11.66.

### Fixed

- **Adding a node no longer refuses a type your install can clearly handle (#636).**
  Asking the agent to add `SaveVideo` failed with *"Required custom widget VIDEO have not
  registered"* — on a canvas where a working `SaveVideo` was already sitting. Retrying
  never helped, because nothing about the check could change.

  The check asks whether a datatype could still be a widget that hasn't finished loading.
  It answers that by looking at whether any installed node *produces* that type. On an
  install where nothing happens to produce it, the answer is permanently "can't tell", and
  the node becomes unaddable forever — even though ComfyUI builds it perfectly well.

  The panel now also looks at the canvas. If a node of that same type is already there,
  how ComfyUI actually built it is visible: an input wired as a connection is a
  connection, and one shown as a widget already has what it needs. That is exactly the
  evidence the reporter was staring at while being told the node couldn't be added.

  This only ever lets an attempt proceed — the newly added node is still checked before
  you're told it worked, so a genuinely missing widget still fails, and a still-loading
  one still gets its full wait first. Nothing changes for a type the canvas can't vouch
  for.

  The other half of that report — `SaveVideo`'s `codec` input — was already fixed in
  0.11.44. Verified here against a live ComfyUI: `SaveVideo` now adds cleanly.

## [0.11.66] - 2026-08-09

> Covers changes since 0.11.65.

### Fixed

- **Updating a node pack no longer dead-ends on some Manager builds (#367).** On certain
  built-in Manager v4 installs, asking the agent to update a pack failed instantly with
  `HTTP 405` — the Manager refuses that particular request on that build, even though
  listing and installing work fine.

  The panel already knows how to talk to those builds; it has a second route for exactly
  this case. It just never tried it. There *was* a fallback, but it dropped to the old
  3.x-style routes, which a modern Manager doesn't serve either — so the retry failed
  too, and update was unusable while a perfectly good route sat unused.

  Now it tries that route before giving up, and remembers which one worked so later
  updates go straight there. On a build where the original request is fine, nothing
  changes — verified against a live Manager here, which accepts it and doesn't serve the
  alternative at all.

  One honest caveat: on the builds this unblocks, the Manager reports no per-task
  result, so the update is reported as *queued* rather than confirmed. Check
  `panel_node_queue_status` and restart ComfyUI to load the updated pack. That is the
  best answer that Manager can give — the bug was getting no answer at all.

## [0.11.65] - 2026-08-09

> Covers changes since 0.11.64.

### Fixed

- **Re-opening the current workflow no longer sends the agent in a circle (#702).**
  Re-opening the tab that is already open answers "the canvas IS this workflow's, but I
  can't call the contents byte-identical" — normal, and not a failure. What that answer
  did not say is that it carries no refreshed workflow stamp, so the agent's *next*
  command was rejected as belonging to a different workflow. And the answer ended by
  recommending exactly that next command.

  Two people followed that advice into the rejection and concluded the only way out was
  reloading the whole panel. It wasn't: listing workflows re-publishes the current
  identity and the read then goes through — one call, no reload. The reply now says so.

  Nothing about how the panel decides which canvas it is bound to changed; the answer
  was right and only its advice was wrong. All four phrasings of that outcome carry the
  correction, and it stays off the case where the workflow genuinely *cannot* be
  confirmed, because there reloading really is the remedy.

## [0.11.64] - 2026-08-09

> Covers changes since 0.11.63.

### Fixed

- **A blank canvas no longer refuses every graph tool (#833).** An empty canvas is the
  ordinary state you are in right before asking the agent to build a workflow — and it
  was the one state where the agent could not read the graph at all. Nothing cleared it:
  re-targeting, creating a new workflow, and re-opening the tab all failed, and the
  latest report adds that it survived both a hard refresh and a ComfyUI restart.

  The guard was not treating "0 nodes" as a wrong canvas, as it appeared. It was
  treating it as *unproven*, and on a blank canvas neither available proof can ever
  succeed: identifying a canvas by its contents is impossible when there are none — every
  blank canvas looks alike — and the other proof requires an unmodified tab, which a
  blank one never is, because creating or clearing it is what marks it modified.

  An empty canvas is now accepted as genuinely empty when both the canvas and the
  workflow are independently shown to hold nothing. There is no content to attribute to
  the wrong workflow, which is the same reasoning the panel already used elsewhere; it
  simply could not be reached here. A canvas that merely *looks* empty because a
  workflow is still loading is still refused, using ComfyUI's own loading signal.

  **Reading works; building does not yet.** Adding nodes to a blank canvas is still
  refused. Proving there is nothing to lose is enough to trust what a read returns, but
  not enough to say *which* workflow an empty canvas belongs to — and a reconnect can
  leave the canvas belonging to one blank tab while the panel is pointed at another, so
  the first node could land on the wrong one. That half is tracked on #833 and needs a
  real identity proof rather than a relaxation.

## [0.11.63] - 2026-08-09

> Covers changes since 0.11.62.

### Fixed

- **Closing a workflow no longer discards changes a node made (#882).** ComfyUI decides
  whether a tab has unsaved work from a snapshot it takes when *you* type or click.
  Anything a node set for you is invisible to it — an ImpactWildcardEncode populate, a
  `control_after_generate` roll, a subgraph's promoted widgets — so the tab kept
  reporting itself as clean while the canvas already differed from the file.

  Two guards exist precisely to stop work being thrown away, and both believed that
  report. Closing a workflow refuses when there are unsaved changes, because closing
  bypasses ComfyUI's own save prompt — it saw "clean" and closed, and the values were
  gone. The confirmation before an operation overwrites the canvas was skipped the same
  way, so the canvas was replaced without anyone being asked.

  Measured: after a save the tab reads clean, correctly. After a node writes a value it
  still reads clean — wrong. Refreshing the snapshot flips it to modified, which is the
  truth.

  Both guards now refresh the snapshot before trusting it, and — this is the part that
  matters — they only trust the answer when the refresh can be shown to have actually
  happened. ComfyUI silently skips it while a graph is loading, while an undo is
  replaying, and in a few other moments, in a way that is indistinguishable from success
  from the outside. When it cannot be established that the refresh landed, the close
  refuses and the confirmation is shown, rather than assuming. `force: true` still
  closes, so nothing becomes unclosable.

  Fourth and last of a family: #696, #874 and #878 were the same stale snapshot read in
  other places — this one was the guards meant to protect you from it.

## [0.11.62] - 2026-08-09

> Covers changes since 0.11.61.

### Fixed

- **Saving a workflow no longer writes stale values over your file (#878).** Saving
  in place persisted ComfyUI's change snapshot rather than the live canvas, and that
  snapshot only records what a *user* typed or clicked. So anything a node had set
  for you was written out at its old value: an ImpactWildcardEncode populate, a
  `control_after_generate` roll, a subgraph's promoted widgets.

  Measured: with 1337 on the canvas, the file on disk received the node's default of
  512. Nothing errored, and the canvas still showed 1337 — a save does not repaint —
  so the file quietly disagreed with the screen until the next reopen.

  Saving under a *new* name already refreshed the canvas first; the route that
  overwrites an existing file was the one that did not. It now does, and refuses the
  save outright if that refresh fails rather than writing something it knows is
  behind.


## [0.11.61] - 2026-08-09

> Covers changes since 0.11.60.

### Fixed
- Centring on a node now honours the zoom you asked for. `panel_canvas` with
  `action:"center_on_node"` accepted a `scale` and quietly ignored it, so "centre on node
  42 at 1.5x" centred at whatever zoom happened to be set — and the reply echoed the old
  zoom back, so nothing said the request had been dropped. The zoom is applied before the
  centring (applying it afterwards would slide the node straight back off-centre), the
  reply reports the zoom that took effect, and a scale outside the accepted range is
  refused rather than silently clamped — the same range `action:"zoom"` already enforced
  (#876, #754)

## [0.11.60] - 2026-08-09

> Covers changes since 0.11.59.

### Fixed

- **Reopening a workflow no longer silently reverts values a node set for you
  (#874).** Reopening an already-open workflow repaints the canvas from ComfyUI's
  change snapshot rather than from the file — and that snapshot only records what
  a *user* typed or clicked. So anything a node wrote by itself was quietly rolled
  back: an ImpactWildcardEncode populate, a `control_after_generate` roll, a
  subgraph's promoted widgets. Nothing errored, and the graph looked right
  afterwards, which is why it read as "my edits didn't stick" rather than as a bug.

  Measured: a value of 1337 on the canvas came back as the node's default of 512.
  The panel now asks ComfyUI to capture the live canvas before it repaints, so what
  is on screen is what gets restored.


## [0.11.59] - 2026-08-09

> Covers changes since 0.11.58.

### Fixed

- **An open Chat history pane now updates itself when you save a workflow
  (#847, partial).** The list was painted once when the pane opened, so if you
  saved a workflow while it was on screen it kept showing the pre-save answer
  until you closed and reopened it.

  This does not yet fix the related report that a chat held on a workflow *before*
  its first save can drop out of "Current workflow only". That needs the panel to
  prove an old identity belonged to the same tab, and it currently cannot — the
  workflow object is replaced by the save, and "no other tab claims this id" is not
  the same as "this tab owned it". Guessing there would attach one workflow's
  conversations to another, so it stays unfixed and #847 stays open.


## [0.11.58] - 2026-08-09

> Covers changes since 0.11.57.

### Fixed

- **Reopening a workflow no longer reads as though work went missing (#696).** When
  the canvas came back with an unfamiliar per-node field — a display toggle like
  `showAdvanced` from rgthree or Impact, alongside the usual re-measured sizes —
  `panel_open_workflow` said it could not tell whether "the load only partly
  applied", which sent people hunting for work to redo that was never gone.

  The panel had been deciding this by checking every differing field against a list
  of names it considered harmless, so one flag it had never seen was enough. It now
  reports what it actually proved: every node that was loaded is on the canvas with
  the same id and type, so no node was lost — whatever fields differ, and without
  needing to know what any of them mean. A difference confined to sizes, positions
  and colours still gets the stronger answer, that the widget values and links
  matched too.

  Also stopped claiming the difference was something "the ComfyUI frontend
  recomputes on load". Node colours are on that same list and nothing recomputes
  them, so that was untrue whenever a colour differed.


## [0.11.57] - 2026-08-09

> Covers changes since 0.11.56.

### Fixed

- **The panel no longer eats the storage ComfyUI needs for your workflow tabs
  (#861).** Chat history kept every pre-v3 transcript in `localStorage` in full,
  forever. That budget belongs to the whole origin, not to the panel, so past a
  point ComfyUI itself could not save workflow drafts — "Failed to save workflow
  draft", and every open workflow tab gone on the next browser restart, with
  nothing in any log pointing at the panel.

  Those transcripts had nowhere else to live, which is why they were never
  trimmed: capping them would have been deleting them. They now have a durable
  home of their own, and only then is the local copy bounded — by size, since one
  transcript full of pasted JSON outweighs hundreds of short ones. Nothing is
  dropped that is not safely stored elsewhere first: if the durable copy cannot be
  written, nothing is trimmed at all.

  Deleting a chat now removes it for good, including from the new store, and a
  delete that fails is retried rather than quietly forgotten.


## [0.11.56] - 2026-08-09

> Covers changes since 0.11.55.

### Fixed

- **A first save no longer hides the chat you had before it (#847).** "Current
  workflow only" showed one of two conversations held on the same tab and the
  same canvas, minutes apart. Saving a workflow migrates its route id
  (`tmp:<uuid>` to `wf:<path>`) and re-mints its storage uuid at the same
  moment, so a chat recorded before the save shared no identity with the live
  workflow and dropped out of a filter named for the workflow it was actually
  held on. The filter now also accepts the workflow's pre-save id, which the
  panel already records — nothing about lineage is guessed, so another
  workflow's conversation still cannot be pulled in. Threads written before a
  save are matched within the session; carrying that across a reload needs the
  stamps rewritten at the save boundary and is still open.


## [0.11.55] - 2026-08-09

> Covers changes since 0.11.54.

### Fixed

- **A deferred tool is no longer read as an absent one (#857).** The live-canvas
  disclosure asked one binary question — is `panel_graph_outline` in your toolset
  or not — and on a backend that defers tool schemas, neither answer is true. A
  Codex session found nothing in its initially advertised tools, found
  `mcp__panel__panel_graph_outline` in the lazy registry, called it, and got the
  live 41-node graph; it had still been told to report the canvas unreachable and
  hand the user three remedies for a healthy install. The lookup now comes first
  and covers both surfaces — a tool you can call is present wherever it came from
  — and it stops after one check, so a session that genuinely has no canvas tools
  still reaches its remedies instead of searching forever.


## [0.11.54] - 2026-08-09

> Covers changes since 0.11.53.

### Fixed

- **The reboot reply now says WHICH ComfyUI it restarted (#851).** `comfy_reboot`
  returned the route (`/v2/manager/reboot`) and never the host, so a caller could
  not tell which server had just gone down. When the panel drives a ComfyUI that
  is not the orchestrator's headless `COMFYUI_URL`, that gap sends a confirmation
  timeout to a fallback aimed at the other machine — which answers "No ComfyUI
  process found on port 8188" while the panel was operating on the live one all
  along. Every branch now carries `target`, and the two failure messages name the
  host in prose; an unknown target is omitted rather than reported blank. The
  confirmation card and its timeout wording are orchestrator-side and unchanged.


## [0.11.53] - 2026-08-09

> Covers changes since 0.11.52.

### Fixed
- `panel_add_node`'s schema-drift refusal pointed at the wrong recovery. When a node class's
  required inputs changed since the page loaded its schema — moving a model file between
  folders is enough — the panel correctly refuses to build the stale shape, but it told you to
  reload the whole ComfyUI tab. `panel_refresh_nodes` clears the same condition in place and
  costs no canvas state: it re-fetches `/object_info` and re-registers the class, which is
  exactly what the refusal is waiting for. The message now leads with that, keeps the tab reload
  as the fallback, and says what the refresh does NOT fix — nodes already on the canvas keep the
  shape they were created with (#852)

## [0.11.52] - 2026-08-09

> Covers changes since 0.11.51.

### Added
- **Panel UI scale.** A new setting in ComfyUI Settings (Comfy MCP Agent → General → "Panel UI
  scale (%)") scales the whole Agent sidebar — text, icons and spacing together — from 100% to
  250%. Reported by a user on Windows 11 for whom the panel text was barely readable.

  Worth knowing if you tried to fix this yourself: overriding `.cmcp-root { font-size }` in a
  user stylesheet does **not** work, and that is not your mistake. The panel's inner sizes are
  `rem`, which resolve against the page root rather than against the panel, so most text ignores
  the override. This setting is the supported way to scale the panel (#753)

## [0.11.51] - 2026-08-09

> Covers changes since 0.11.50.

### Fixed
- Switching workflow tabs could leave every `panel_*` graph tool refusing the ACTIVE workflow
  with `root-workflow-uuid-mismatch`, until the user re-opened the workflow that was already
  open. ComfyUI reuses one canvas object across tabs and does not reset its metadata, so the
  previous workflow's identity tag stays behind on a canvas that now holds the new one's graph.

  The panel could already recover a canvas carrying NO tag — it proves the canvas is the active
  workflow's by comparing content, then stamps it. It could not recover one carrying the WRONG
  tag, because that stamp is never overwritten. A wrong tag was therefore stickier than no tag:
  a byte-identical canvas was allowed in one case and refused in the other. The same content
  proof now settles both.

  Deliberately unchanged: a canvas that is genuinely a different workflow's still refuses, and
  so does an ambiguous one — a second clean tab holding identical content, a tab with unsaved
  edits (whose state can lag the real canvas), or a check that could not run at all (#817)

## [0.11.50] - 2026-08-09

> Covers changes since 0.11.49.

### Fixed
- An interactive card the agent had just created could stop responding to it mid-turn.
  `panel_ui_render` returned a card_id and an immediate `panel_ui_update` failed with
  "no live card" — no click, no dismissal, no view switch. Any repaint of the chat feed
  between the two calls (which happens on its own) replayed the card as a finished, inert
  one and dropped the handle the update needs. An unanswered card now comes back live
  under the same id the agent was given; an answered or dismissed one still comes back
  inert, so a question you already answered is never re-offered. Card ids are also now
  collision-resistant across a page reload, and the provisional paint that runs before the
  panel has decided which conversation is authoritative stays inert deliberately, so a
  card can never come back live in a conversation that is about to be replaced
  (#837, #832)

## [0.11.49] - 2026-08-09

> Covers changes since 0.11.48.

### Fixed
- An EMPTY (0-node) workflow no longer wedges every `panel_*` graph tool. A blank canvas is
  exactly the state a user is in right before asking the agent to build something, and it was
  the one state in which nothing could be read or edited — with no recovery: re-targeting
  reported success without changing anything, `panel_new_workflow` made it worse, and
  `panel_open_workflow` could not prove its rebind. A browser refresh was the only exit.

  The panel proves a canvas genuinely empty before trusting a 0-node read, and that proof
  required every value in the workflow's `extra` to be empty — which nothing on a real install
  satisfies, because ComfyUI stamps `extra.frontendVersion` into every workflow it writes and
  installed extensions add their own per-workflow flags. So no blank workflow was ever provably
  empty, and the fallback (stamping the canvas with the workflow's identity) is refused when
  another blank tab could equally explain the empty canvas. Two blank tabs therefore had no exit
  at all — and `panel_new_workflow` creates the second one, which is why that step escalated it.

  A version stamp is not a graph. Booleans and numbers in `extra` are now admitted (a graph
  cannot be encoded in one), and named version strings are admitted when they look like version
  strings. Anything structured — or any text carrying JSON delimiters, wherever it appears — is
  still treated as content, so a canvas that actually holds something is never proven empty
  (#833)

## [0.11.48] - 2026-08-09

> Covers changes since 0.11.47.

### Fixed
- A run that finished without producing an image or a video now tells the agent it
  finished, instead of leaving it waiting forever. `panel_run` promises the agent it will
  be notified automatically and instructs it not to poll — so for a run whose outputs are
  text, or a cache hit that saves no file, that notification could never arrive and the
  agent stalled silently until the user prompted again. The promise is what turned a quiet
  completion into a wedged session. The completion is now delivered on the live path and
  recovered by the `/history` reconcile, including when the bridge was down at the moment
  it first fired. Only runs the panel itself queued are affected — a render you start on
  the canvas yourself is still silent (#831, #356)
- `panel_open_workflow` reported a repaint the ComfyUI frontend had performed FAITHFULLY as a
  possible partial load. The content check names the graph SURFACES that disagreed, and `nodes`
  is one surface holding the whole serialized node array — so "the graph differs on: nodes" came
  out identically whether a node had vanished or the frontend had merely re-measured every box on
  load, which it routinely does. A reporter read that after a healthy open and went looking for
  work to redo that was never gone. The disclosure now says which of the two it observed: when
  every loaded node is on the canvas with the same id and type and only presentation differs, it
  says so and names the fields. A changed widget value, title, flag or mode is NOT presentation
  and still gets the full warning, and the verdict itself is unchanged — the open still reports
  the content as unconfirmed (#825, #830)
- A stray NUL byte in `layout-engine.js` made git treat the file as binary, so it had no
  reviewable diff; the edge-dedup key it separated is also now collision-proof, which it was not
  (#825, #830)

## [0.11.47] - 2026-08-09

> Covers changes since 0.11.46.

### Added
- Large images and videos can be collapsed **in place** in the chat transcript. Every media
  card gets a disclosure chevron; collapsed, it becomes a one-line stub naming the file that
  is itself the way back (click, Enter or Space). This is the opposite of the existing `⛶`
  button, which opens the lightbox — one goes smaller, one goes bigger. Collapse state is
  remembered in `sessionStorage`, so it survives a reload and a thread switch inside the tab
  and clears when the tab closes. Collapsing a video releases its decoded `<video>`
  immediately instead of leaving it decoding behind a hidden box, and expanding an
  off-screen card does not resurrect one (#818, #823)

### Fixed
- An EMPTY ComfyUI-Manager catalogue no longer renders as “no matches”. A `getmappings`
  response with no packs in it came back as `count: 0` — exactly what a healthy catalogue
  returns when a query matches nothing — so the two were indistinguishable, and a user
  whose Manager had no catalogue at all concluded the pack did not exist and kept trying
  variations of a search that could never succeed. A zero-pack catalogue is now reported as
  its own state: nothing was searched, so nothing follows about whether the pack exists.
  The message names the host the catalogue actually comes from (Manager’s default channel,
  not the pack-install registry) and the causes ComfyUI-Manager really produces an empty
  one from — offline mode with no cache yet, or missing/unreadable Manager data files.
  Note that a network failure does NOT empty the catalogue: Manager falls back to the copy
  bundled in its own package, so a blocked channel surfaces as a STALE list rather than an
  empty one, and telling stale from current is a gap this does not close (#808, #826)

## [0.11.46] - 2026-08-08

> Covers changes since 0.11.45.

### Fixed
- `panel_add_node` refused a node whose input types ARE produced by nodes already on the
  canvas. The socket proof — "which datatypes does some installed node output?" — was being
  read off the single-class `/object_info` payload introduced in 0.11.45 for the cheap
  per-class existence check, so any custom link datatype produced by a SIBLING node read as
  unproven and the refusal claimed "no installed node outputs X" while the node producing X
  sat on the canvas. Nothing could clear it: `panel_refresh_nodes` re-registers the class,
  which is exactly what armed the fast path. The proof is now widened against the whole
  schema on the path that is about to refuse, so the cheap path is kept for every add that
  does not need it (#822, #821)
- `panel_move_group` treated a restored node position as an unrestorable node, so a
  rollback reported failure after it had in fact succeeded (#819)
- `panel_update_node` sent extra fields that made Manager v4's untagged Pydantic union
  match `InstallPackParams` instead of `UpdatePackParams` and crash (#816)

## [0.11.45] - 2026-08-08

> Covers changes since 0.11.44. Versions 0.11.42-0.11.44 shipped without CHANGELOG sections;
> see their release commits (#709, #722, #743) until those are backfilled.

### Added
- show whether the QR's URL survives an orchestrator restart (#770)
- return the workflow_uuid it just minted (#762)

### Fixed
- a value the widget's own grid explains is NOT a failed write (#806)
- the soft_reload REPLY reports the refusal, not "scheduled" (#803)
- refuse an agent reload that unsaved work will block (#801)
- report the workflow instance a save leaves active (#800)
- try the option key the api layer actually reads (#799)
- scan the live graph for unavailable widget values (#745) (#798)
- civitai_results reported an empty feed; e2e stubbed a retired endpoint (#796)
- the internal-logs endpoint is NOT under /api — both readers were no-ops (#792)
- an unknown node type may be a pack that FAILED TO IMPORT (#791)
- a missing node type may be a pack that FAILED TO IMPORT (#790)
- a union of PRIMITIVES needs no registered widget (#789)
- find the tab button the way 1.50 marks it, at the SECOND site too (#786)
- a blank tab is never an acceptable failure state (#785)
- the sidebar guard must not destroy on an UNKNOWN active tab (#784)
- say that a capture frames the WHOLE graph (#783)
- read the reason ComfyUI logged instead of repeating the one it made up (#782)
- a combo refresh that found nothing is not a refresh (#781)
- API-format workflows ARE loadable — import them (#778)
- drop the frontend version range, print what the body held (#777)
- name the button the panel cannot press (#776)
- disclose that missing-asset detection is load-time only (#774)
- say when a commanded frontend reload did not happen (#773)
- a userdata 400 says what it can mean, and where the real cause is (#772)
- keep the upload status and the exception (#764)
- report the comparison, not a cause the panel never observed (#763)
- let an UNSAVED canvas publish its established identity (#761)
- let the recovery probe through both target guards (#759)

### Changed
- give gotoStep the 15s its capability probe actually takes (#797)
- recover 9 e2e tests — off-by-default flags and a routed mount probe (#795)
- declare every reach into ComfyUI's own DOM (#787)
- verify ONE node type, not the whole schema (#780)


## [0.11.41] - 2026-08-05

### Fixed
- the changelog generator silently dropped the entries that mattered most (#657)

### Changed
- **`to_node_id` is honoured instead of only refused (#556).** Running "up to node N"
  used to run the WHOLE graph — a different request executed successfully, spending real
  GPU time or API-node credits on work nobody asked for. An earlier fix made the panel
  refuse instead, which was safe but refused every time, so the feature was unusable.
  A last-resort delivery attempt now writes the scope into the run's own `/prompt` body —
  the one interface every frontend build shares — identity-gated on the run's mark and
  content hash, never overwriting a value it cannot interpret, and disclosed via
  `scope_applied_by`.

  Reading the real frontend sources (1.42.15, 1.47.11, 1.50.1) showed that **every one
  accepts both `app.queuePrompt` argument shapes**, so the old refusal's assertion that
  "this frontend build ignored the run-to-node argument" was almost certainly wrong — and
  three field reports pasted it verbatim into the tracker. The root cause is still unknown;
  the outcome is now correct regardless of which layer drops the scope, and the next report
  will be diagnosable. Ten adversarial rounds found ten distinct paths by which a request
  could still reach the network unscoped — including a retrying run restoring its
  entry-time `fetchApi` over a concurrent run's guard. #581 needed no code: already fixed
  on main by #594 and #621.


## [0.11.40] - 2026-08-05

### Fixed
- **`panel_show_media` no longer dead-ends on video, and no longer acknowledges a delivery
  it did not make (#649).** Under the size ceiling the panel painted a player for the *user*
  and returned `{ok:true,count:1}` to an agent that had been shown nothing. An absent handler
  now fails loudly, and a handler that returns nothing reports the delivery as UNKNOWN.
  Oversized video routes through the existing storyboard pipeline with an explicit disclosure —
  the video was **not** sent, the sheet is N *sampled* frames, and `get_image` is the way to
  actually look at it. A partial sheet withholds the "evenly-spaced" claim. Also fixed:
  `clip.mp4?download=1` classified as an image, `/.(mp4|webm)$/` matching `xmp4`, and a
  truthy-but-unusable upload reference producing a `get_image` remedy with an empty filename.
  The 20 MB refusal itself is orchestrator-side and still open (artokun/comfyui-mcp#854).
- **`workflow_open` now says which check it could not prove (#653).** The verdict is split and
  named (`instance` / `marker` / `identity` / `content`), so a failure states which observation
  failed and which two values disagreed, instead of four distinct causes collapsing into one
  message that asserted whichever it happened to name. An attempt-scoped single-use marker
  proves the rebind with evidence a stale tag cannot fake. The long-standing "two dialects"
  hypothesis was tested and **refuted**; whether the whole graph *landed* is still reported as
  unknown, deliberately — a `configure()` failure that silently drops widget values is
  byte-identical to the loader normalizing them. Partially addresses #604, #603, #616, #374;
  closes #641.
- say when the live-canvas tools may not have reached the agent (#291) (#633)
- the `waitForQueueDrain` test was flaky under load — it stubbed a bounded delay with a real
  `setTimeout` against a 5s budget, so a loaded machine consumed the whole budget before the
  polls completed. The injected delay now resolves instantly, and the test additionally asserts
  the loop's pacing, which it had been taking on trust (#652)


## [0.11.39] - 2026-08-04

### Fixed
- **CRITICAL: mutations could reach the WRONG graph** — nodes deleted from another
  workflow, and writes reported not-applied that were in fact applied (#621).
  After a ComfyUI restart with no page reload, the panel could point the canvas at an
  empty root while the user's unsaved graph was still on screen; every downstream guard
  was then handed a self-consistent pair that no longer described the canvas the command
  was issued for. The divergence is now detected and refused instead of silently
  repointing, the dispatch fence no longer exempts mutations from the baseline read
  guard, and the destructive revert path awaits its load, fences both the bridge and the
  user, and reports a discriminated outcome rather than a null that meant two different
  things. Fixes #545, #442, #308, #220; partially addresses #604, #603, #616, #374.
- repair main — #614's title coercion broke #631's move-group harness (#643)
- truncated results name their own remedy — and one that works from where the caller is (#614)
- make panel_move_group a verified transaction that never reports a move it did not make (#408) (#631)
- prevent restart resume from duplicating an active render (#585) (#597)
- materialize V3 custom widgets before add (#593)
- label cancelled reconnect runs truthfully (#582) (#595)
- reply before expensive graph snapshot (#581) (#594)
- separate stale red outlines from errors (#579) (#592)
- report outer previous value for promoted widgets (#591)
- the fixed-ness check must GATE the volatile exclusion (codex r2)
- refuse the false-empty authoritative read (empty-binding-unproven)
- narrow + surface the volatile-input exclusion (codex gate)
- exclude linked value-control targets from the scoped-run drift hash


## [0.11.38] - 2026-08-03

### Fixed
- missing_media no longer false-positives on [output]/[input]/[temp]-annotated paths (annotation parsed per folder_paths.annotated_filepath exactly, unspaced and clamp cases included) (#743) (#568)
- the binding guard heals proven drift after a reconnect/multi-tab switch and only ever re-stamps a stale root tag on a proven-clean, proven-empty canvas; non-empty surfaces stay strict both ways (#560, #565) (#570)
- phantom missing_model clears when the node's CURRENT widgets resolve a real asset (widget-shift repair); annotated values are classified before combo membership so [output]/[temp] can never be combo-cleared (#569) (#574)
- a first save consumes the temporary Unsaved tab via its proven produced record — no more duplicate modified Unsaved tabs, and the save-swap identity carry fires correctly (#566) (#575)

## [0.11.37] - 2026-08-03

### Fixed
- the published Registry pack ships web/js/vendor/ runtime modules again — a bare `vendor/` line in .comfyignore matched at any depth and excluded them from 0.11.33-0.11.36 packs, breaking the panel for Registry installs (#749) (#567)
- missing_media no longer false-positives on [output]/[input]/[temp]-annotated paths with subfolders — annotation is parsed before probing, against the annotation's root (#743) (#568)

### Fixed
- `panel_add_node` / `panel_set_widget` unknown-type errors now point at `get_node_info` (the live /object_info node-class oracle) instead of `panel_search_nodes`, which searches installable Manager packs and can never resolve an exact class_type (mcp#741)

## [0.11.36] - 2026-08-03

### Fixed
- panel_run scoped dispatch guard: per-run queue marks, content-hash drift detection, refusal before any scope-dropped/corrupted/drifted dispatch leaves the browser (deferred posts included via cancel-or-page-lifetime-sentinel), verified = completed 200+prompt_id, terminal-truthful partial batches — never a silent full-graph run (#556) (#559)
- graph-binding identity system rebuilt: the desync guard self-heals proven active-lineage drift and fails closed on foreign/untracked/unclaimed tags; identity transfers uniformly require object-keyed evidence (raw-canonical stores with conflict vetoes) or API/event-threaded succession proof across all four paths — carry, creation registration, guard rebind, lazy backstop (#545, #557) (#558)

## [0.11.35] - 2026-08-02

### Added
- stamp the session epoch from any epoch-carrying frame (#694) (#549)
- add atomic node editor

### Fixed
- recheck graph_set_widget workflow targeting at the post-await write boundary (#718)
- recover dirty graph reads
- bind restart readiness to browser tab identity
- scope command retries to session epoch (#550)
- prevent dirty graph-binding false positives (#545) (#546)
- reject mismatched retry tokens (#547)
- retry identity via retry_of + session-epoch replay gating (#694) (#543)
- validate legacy color and mode targets
- normalize legacy numeric node ids
- retain legacy rail aliases
- validate consolidated node targets
- validate consolidated title input
- validate legacy presentation inputs
- preserve legacy motion compatibility
- preserve legacy color behavior
- preserve legacy title and color nulls
- preserve atomic edit rollback and legacy commands
- fence stale nonempty workflow graph (#349)
- centralize stale outline cleanup
- retain missing-node-type outlines
- clear stale root outlines after subgraph conversion (#516)
- restore CivitAI keyword search results


## [0.11.34] - 2026-08-02

### Added
- add pi.dev provider chip across the panel (#491)
- wire MiniMax as a first-class hosted-API-key provider (#355)
- 0.49.0 vocabulary gate rebased onto 0.11.32 main
- graph_set_node_property — set a node's LiteGraph property live (#488) (#501)
- expose per-item `gated` + cap the media proxy read (supports mcp#623)
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- gate pi ready ack on backends state
- leave pi readiness to orchestrator
- require verified local pi auth for ready state
- reject pi shell shims during readiness
- resolve case-colliding names exactly (#524)
- align pi CLI probe with shell-less spawn
- dedupe bridge command rids so a replayed mutation can't double-apply (#517) (#521)
- invalidate in-flight reorder/drag state when a push rehydrates the editor (#506)
- keep panel_open_workflow's outcome truthful across the mid-command disconnect (#402, #508, #442 defect 2) (#514)
- fail closed on unresolved ties even with explicit segments; key the per-segment field carry on content (#506)
- verify nested input media before reporting missing (#518)
- refuse an explicit-segments push that would destroy a detected in-flight edit (#506)
- authorize promoted subgraph containers via the resolved concrete inner target (#512) (#523)
- fail closed on merge-base ties; preserve fields the editor does not model (#506)
- drop model-level nsfw:true entries under SFW browsing masks (#515) (#520)
- replace literal NUL map-key sentinels with printable form (#510) (#519)
- share one frontend-only-node allowlist between the sibling widget guards (#496) + writable empty dynamic combo (#507) (#511)
- add a pre-load editor snapshot so stale-vs-uncommitted is observed, not inferred (#506)
- classify a discarded timeline copy by which branch settled authority (#506)
- stop settling merge-base authority on the lossy prompt join (#506)
- length equality reuses the lossless write-path rule ("2e3" != 2000) (#506)
- disclose a discarded editor copy when timeline_data is unreadable (#506)
- decide overwrite disclosure structurally, never via the lossy prompt join (#506)
- disclose the timeline_data copy set aside when the editor wins the merge base (#506 codex round 7)
- report an out-of-band derived value even with no readable base timeline (#506 codex round 6)
- whitespace notice tracks python str.strip() exactly, not JS trim() (#506 codex round 5)
- disclose an in-flight prompt edit replaced by an explicit segments write (#506 codex round 4)
- refuse unsafe/exponent segment lengths + pin the graph_set_widget wiring (#506 codex round 3)
- widget-first merge base + python-parity whitespace notice (#506 codex round 2)
- prefer the live editor timeline as the merge base + refuse coerced colour/length (#506 codex round 1)
- reconcile local_prompts when timeline_data updates on PromptRelayEncodeTimeline (#506)
- rename isWorkflowCreationLoad → isNewWorkflowLoad (YARA SUSP_SVG false-positive on 'onload' substring)
- resolve the workflow selector over the executor's exact collection (no over-fence) (#570 P1)
- fence PINNED commands too — the pin guard authorizes by path, not uuid (#570 P0)
- fence workflow_rename/close by RESOLVED TARGET, not raw path presence (#570 P0)
- fence all four workflow mutators + stop over-fencing explicit-path ops (#570 P0c)
- back cross-workflow node clipboard with a non-quota in-memory store (#500) (#502)
- scope the workflow-instance fence to active-workflow mutations (#570 P0c)
- keep-instance identity for graph_load + advertise stamp enforcement (#570 P0b/P0c)
- frontend-only rgthree nodes (#475) + outer promoted display-proxy sync (#477) (#479)
- match LiteGraph containsCentre rule for group membership (#497)
- fence command execution to the active workflow instance (#570 P0)
- fail closed when the creation-boundary fork is not installed (#570 P0)
- anchor unsaved identity on the live object, invalidate stale cache on in-place reload (#570 P0b)
- fork legacy/unmarked embedded uuids on unsaved reload (#570 P0b)
- legacy Manager 3.x install — negotiate queue/start method + unreachable fallback (#485, #486)
- make the creation-load classifier fail-safe — fork on any non-ComfyWorkflow arg (#570 P0)
- derive Ultralytics bbox/segm dir from combo prefix (#487)
- fork per-instance identity at the workflow CREATION boundary (#570 P0)
- unsaved uuid reuse fails closed on a missing graph id (#570 P0b)
- durable per-instance uuid for unsaved workflows; fork on cold import (#570 P0b/P1)
- emit the durable per-instance workflow uuid in every hello (#570)
- in-place-overwrite gate must compare RAW BYTES, not decoded text (#442 defect 3)
- content-equality gate for in-place save + late stale read (#442 defects 2,3)
- stale-tab detection on open + in-place save 409 (#442 defects 2,3)
- report EFFECTIVE widget state + stop blobs starving the node you asked for (#607, #609) (#482)
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.33] - 2026-08-02

### Fixed
- `panel_set_widget` on `PromptRelayEncodeTimeline.timeline_data` no longer leaves the node rendering the PREVIOUS prompts. That node's Python `execute()` reads only `local_prompts` + `segment_lengths` — never `timeline_data` — and both are derived by the in-browser timeline editor, so a raw `timeline_data` write reported success while the render silently kept the old prompts (and was reverted on the next UI touch). The write now regenerates both derived widgets from the new timeline and applies all three atomically, re-hydrates the live editor so its next commit is a no-op, merges onto the node's current timeline so unmentioned fields are preserved, and REFUSES any value the node would silently coerce or reset to a blank default. Direct writes to the derived widgets are refused with a redirect, and a node found already out of sync returns its previous prompt text rather than dropping it silently (#506)
- Bridge command dedupe: every command frame is recorded by rid + payload fingerprint, and a duplicate delivery (a bridge-timeout retry) is answered with the ORIGINAL reply instead of re-executing — a retried mutation can no longer double-apply and create duplicate nodes (#517)
- `panel_open_workflow` stays truthful across a mid-command disconnect: outcome is correlated by rid/last_open (never inferred from `workflow_list.active`), the reload guard can no longer expire while a load is genuinely in flight (a late disk reload can't clobber an acknowledged edit), a post-NewBlankWorkflow error says "Do NOT retry" instead of inviting a second blank tab, and the modified-tracker is never re-baselined without the interaction freeze (#402, #508, #442 defect 2)
- `panel_get_errors` verifies nested input media before reporting `missing_media`: files in input SUBFOLDERS are probed, backslash is only a separator on Windows servers (`sys.platform` — not POSIX), and a workflow switch mid-probe discards the stale verdict instead of reporting it for the wrong workflow (#513)
- `panel_set_widget` authorizes promoted widgets on outer UUID subgraph containers through their resolved, authorized concrete inner target instead of refusing every virtual-subgraph node; genuinely unresolvable promotions still refuse (#512)
- SFW CivitAI browsing drops model-level `nsfw: true` entries (the API returns them even with `nsfw=false`); adult-inclusive masks are unaffected (#515)
- `panel_set_widget` shares ONE frontend-only-node allowlist between the sibling guards (MarkdownNote/Note/Reroute + rgthree types) and can write a dynamic combo whose server-side option list is empty (StarNodes Ollama "model") (#496, #507)
- `web/js/comfyui-mcp-panel.js` carries no literal NUL bytes — the two map-key sentinels are printable `"\x00"` escapes, byte-identical at runtime, so the file diffs as text again (#510)

### Changed
- Re-vendored `tool-vocabulary.json` from comfyui-mcp 0.49.0 (169 core / 90 panel / 19 dead names, covering the bisect and snapshots/batch/apps consolidations) — the lint gate now rejects any live reference to a retired tool name (#522)

## [0.11.32] - 2026-08-01

### Fixed
- `panel_copy_nodes` no longer throws `QuotaExceededError` ("The quota has been exceeded.") when copying many nodes with large widget payloads — the cross-workflow clipboard is backed by a non-quota in-memory store instead of only `localStorage`, so a big copy survives the workflow switch and `panel_paste_nodes` reconstructs every node and intra-set link (native Ctrl+C still wins when it replaces the clipboard after a tool copy) (#500)

### Added
- graph_set_node_property — set a node's LiteGraph property live (#488) (#501)
- expose per-item `gated` + cap the media proxy read (supports mcp#623)
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- frontend-only rgthree nodes (#475) + outer promoted display-proxy sync (#477) (#479)
- match LiteGraph containsCentre rule for group membership (#497)
- legacy Manager 3.x install — negotiate queue/start method + unreachable fallback (#485, #486)
- derive Ultralytics bbox/segm dir from combo prefix (#487)
- in-place-overwrite gate must compare RAW BYTES, not decoded text (#442 defect 3)
- content-equality gate for in-place save + late stale read (#442 defects 2,3)
- stale-tab detection on open + in-place save 409 (#442 defects 2,3)
- report EFFECTIVE widget state + stop blobs starving the node you asked for (#607, #609) (#482)
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.31] - 2026-08-01

### Fixed
- group membership matches LiteGraph's `containsCentre` rule (group box contains the node's centre point), not box overlap — a node whose centre is moved out of a group is no longer reported as a member by `panel_graph_outline` / `panel_edit_group` (#497)

### Added
- expose per-item `gated` + cap the media proxy read (supports mcp#623)
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- frontend-only rgthree nodes (#475) + outer promoted display-proxy sync (#477) (#479)
- legacy Manager 3.x install — negotiate queue/start method + unreachable fallback (#485, #486)
- derive Ultralytics bbox/segm dir from combo prefix (#487)
- in-place-overwrite gate must compare RAW BYTES, not decoded text (#442 defect 3)
- content-equality gate for in-place save + late stale read (#442 defects 2,3)
- stale-tab detection on open + in-place save 409 (#442 defects 2,3)
- report EFFECTIVE widget state + stop blobs starving the node you asked for (#607, #609) (#482)
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.30] - 2026-08-01

### Added
- expose per-item `gated` + cap the media proxy read (supports mcp#623)
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- legacy Manager 3.x install — negotiate queue/start method + unreachable fallback (#485, #486)
- derive Ultralytics bbox/segm dir from combo prefix (#487)
- in-place-overwrite gate must compare RAW BYTES, not decoded text (#442 defect 3)
- content-equality gate for in-place save + late stale read (#442 defects 2,3)
- stale-tab detection on open + in-place save 409 (#442 defects 2,3)
- report EFFECTIVE widget state + stop blobs starving the node you asked for (#607, #609) (#482)
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.29] - 2026-08-01

### Added
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- report EFFECTIVE widget state + stop blobs starving the node you asked for (#607, #609) (#482)
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.28] - 2026-08-01

### Added
- refresh_nodes executor — force /object_info re-register on demand (#608)

### Fixed
- recover run-completion missed on unobserved reconnect (#356) + refuse false-clean empty-graph reads (#389)


## [0.11.27] - 2026-08-01

### Fixed
- **`panel_run` no longer crashes on a VHS node with a null widget value, and the CivitAI browser stops 400ing on reopen (#445, #459).** VHS_VideoCombine's `serializeValue` calls `.replace` directly on a null `filename_prefix` inside ComfyUI's `graphToPrompt`; a serializer-level null-safe wrap on `app.graphToPrompt` coerces null/undefined widget values to a safe default for the serialization window only (live workflow left byte-identical, reference-counted for overlapping serializations). And CivitAI's REST list endpoints reject an out-of-enum `sort`/`period`; those are now clamped to the offered enums at the client dispatch boundary.
- **`panel_get_errors` re-evaluates missing-asset + red-node state so a stale "missing"/red never persists (#407, #410, #415, #418).** A valid subfolder-registered model is no longer flagged missing (authoritative `/object_info` pull on a flagged candidate), the `missingMedia` store + red flags are recomputed against a freshly-refreshed graph at query time (a fixed/renamed/exposed asset clears), and `set_widget` clears LiteGraph's `has_errors` after a successful write when nothing still blames the node.
- **Codex readiness resolves the CLI under ComfyUI Desktop's minimal GUI PATH (#434).** Desktop launches with `/usr/bin:/bin:…` only, so `shutil.which` missed a Codex CLI in `~/.local/bin` / `/usr/local/bin` / `/opt/homebrew/bin` and reported it absent (silent Ollama fallback); readiness now probes those well-known bin dirs (exec-bit checked, non-Windows).

## [0.11.26] - 2026-08-01

### Fixed
- **`panel_remove_node` no longer crashes on reroute/subgraph-boundary nodes, and the "manual changes" notice stops contradicting the live graph (#420, #369).** Node removal recovers from the `findInputSlot is not a function` TypeError (severs residual links at the record level, preferring reroute/layout-aware `LLink.disconnect()`), and the manual-change diff runs only when the reconnect epoch + workflow identity both match — so a reload/resume reseeds silently instead of emitting a false per-node delta.
- **Group read tools use live geometry, and read tools flag a stale "active" workflow briefly after a reconnect (#429, #433).** The group-membership read/consume handlers (`graph_get_state`/`graph_outline`/`graph_query`/`graph_auto_layout`/`graph_edit_group`/…) resync node rects to live pos/size before computing geometric membership (no staleness after a non-panel paste/load/drag), and `panel_list_workflows`/`panel_graph_outline` surface an `active_possibly_stale` hint for a bounded window after a ComfyUI reconnect (epoch-ordered + monotonic-clock-windowed, TOCTOU-guarded).
- **Every open sidebar tab's bridge reconnects after a soft-reload (#419).** Hardens the #379 fix so `softReload()` guarantees `client.start()` on every path (extracted to a DI-testable `performSoftReloadRecovery()`), with an N-tab independence regression test — no tab left permanently disconnected.
- **Regression-locked the shipped subgraph run/set_widget behavior (#438, #439, #435).** `panel_run` targeting an output node inside the active/nested subgraph and `set_widget` firing a promoted widget's inner callback were already fixed in 0.11.25; extracted `resolveRunToNodeTarget()` and added non-vacuous regression tests so they can't silently regress.

## [0.11.25] - 2026-08-01

### Added
- **`panel_resize_node` resizes a node on the live canvas, and `set_widget` can drive the LTXDirector timeline (#530, #314).** Resize prefers `setSize()` so a Note/MarkdownNote reflows to a readable size (undo-enveloped). LTXDirector's timeline is driven through the node's own `_applyLoadedTimeline` re-hydration, keyed strictly to the `LTXDirector` node type and merged onto the current snapshot (never a general widget-replay), so omitted tracks are preserved and derived widgets are refused loudly.

### Fixed
- **Subgraph exit/run/unpack are scope-aware and safe (#412, #411, #405, #409).** Exiting a nested subgraph pops to the immediate parent (not the workflow root); `panel_run` can target an output node inside a nested subgraph; `panel_unpack_subgraph` is atomic (fully unpacks or rolls back on error instead of leaving a half-unpacked graph); and an unsafe positional bypass of a multi-input subgraph is refused unless `force:true`.
- **`softReload()` no longer wedges the bridge (#379).** The by-design `503` from `/comfyui_mcp_panel/reload` always hit the failure branch and returned after stopping the client without restarting it (permanent connected-chip/dead-bridge). It now reconnects on every path (bounded), with bridge-lifecycle hardening (instance-guarded listeners, async-reply guard, handshake-timer guard).
- **The PLAN box spinner stops when the agent is idle (#492).** A plan step left `active` when a turn ended kept spinning forever; the glyph now spins only while the agent is actually working and reverts to a static dot on turn-end/interrupt/disconnect.
- **`panel_copy_nodes` warns at copy time when copied nodes can't round-trip (#286)** — an unregistered/uninstalled pack type is surfaced as `unregistered_types` + a warning instead of a bare `copied:N` that then silently drops on paste.
- **Type-name slot addressing, CivitAI search timeout, legacy-Manager node search (#406, #417, #426).** `panel_connect` resolves `from_output="IMAGE"` (a type name) against slot types instead of refusing it (ambiguous type → refuse, not guess); the CivitAI workflow search has a 15s timeout (no more infinite `loading`); and `panel_search_nodes` falls back to an `/object_info` search when a legacy Manager is unreachable.

## [0.11.24] - 2026-08-01

### Added
- **In-app media lightbox for inline chat media (#163).** Clicking a generated image/video in the chat now opens a self-contained, theme-aware full-size overlay viewer with prev/next across all chat media (wrapping) and Esc/backdrop/close dismissal, instead of dumping the raw file into a new browser tab. IME-guarded and click-consuming so it never leaks to the ComfyUI canvas.

### Fixed
- **Model picker is Claude-family-aware and readiness no longer false-positives (#377, #378).** The picker collapses each Claude family to its newest advertised version and derives a clean label from the id (`claude-opus-5` → "Opus 5") instead of showing a stale `opus`→4.8 alias as "Opus" and the newer model as an unrecognized "Custom model" — all from the orchestrator's authoritative advertised ids, no hardcoded map (Fable `-fast` variants + up-to-date-SDK alias dedup preserved). And `_provider_auth("claude")` now requires a genuinely-present access/refresh token instead of reporting ready on a mere-existing but empty `~/.claude/.credentials.json`.
- **`panel_connect` verifies a link actually persisted, and a freshly-uploaded image is selectable (#397, #387).** connect no longer reports success on a widget-backed input (e.g. ImpactSwitch `select`) that accepts-then-reverts the link — it confirms the link across the graph's link store and cleans up only its own dangling remnant on failure; and a subfolder-nested upload (`xyr_canvas/foo.png`, which `LoadImage`'s `/object_info` never lists) is now accepted via an extension-gated, existence-probed upload-asset fallback.
- **`panel_get_errors` surfaces missing node types on bypassed/muted nodes with an honest clean/summary verdict (#399, #356).**
- **`panel_move_group` refreshes member rects and `panel_create_group` uses live geometry (#408, #416).** Moving a group now shifts each member's cached rect by the exact delta (no "box moved, members stayed"), and create-by-bounds resyncs candidate rects to live pos/size so stale rects (paste/load) no longer yield wrong `node_ids`.
- **Context ring is scoped per-workflow and the canvas preserves the center on zoom (#381, #401).** The ring fill is keyed strictly to the active thread (no leftover fill from the previous workflow after a switch), and `panel_canvas` zoom holds the graph-space center set by `center_on_node` constant across the scale change.

## [0.11.23] - 2026-08-01

### Fixed
- **`panel_create_group` correctly builds a group from the requested nodes (#566, #388, #391).** Requested `node_ids` (numbers) were compared against live LiteGraph member ids (strings) with raw sets, so `9 !== "9"` — every member was reported as *both* extra and missing (#566), a spurious "membership is geometric" warning fired on every call (#388), and a stale cached bounding rect made the group come up empty (#391). Membership is now compared on a normalized key, and each node's cached rect is resynced to its live position/size before the group box is computed — so the requested nodes are provably enclosed and the warning fires only on a genuine difference.
- **Chat composer no longer leaks pastes to the canvas, sends early on a CJK IME, or renders legacy `[object Object]` (#384, #385, #393).** Pasting an image into the composer now stops the event from bubbling to ComfyUI's canvas paste-to-node handler (no more duplicate `LoadImage` per paste); a new IME guard (`isImeComposing`) is applied across every composition-context keydown (composer, slash/mention menu, model + side-panel search, `panel_ask`, secret input, RunPod pod-id, and the document-level interrupt/Escape handlers) so a Korean/CJK commit-Enter no longer sends early and leaks a trailing syllable; and legacy persisted `"[object Object]"` chat artifacts are dropped on replay.
- **Freshly downloaded models are selectable on the live canvas without a reload (#396), and a Manager search result installs by its id (#394).** After `download_model` completes, the loader combos now get a guaranteed trailing re-registration of node defs (coalesced, with a completion-race guard) so the new file appears immediately; `panel_install_node` derives the installable id from the pack's repo URL/reference instead of the human title, so a titled search result no longer becomes a silent no-op.

## [0.11.22] - 2026-08-01

### Fixed
- **`set_widget` refuses a scalar/wrong-typed write to a composite widget instead of silently corrupting it (#560), and warns when a value is governed by `control_after_generate` (#558).** rgthree Power Lora Loader slots (`{on, lora, strength, strengthTwo}`) are now written via schema-validated sub-field addressing (`lora_1.on`) that fails closed on unknown fields and enforces each field's declared type independent of its current value — a bare scalar or wrong-typed write no longer overwrites part of the object and reports success, and a partially-corrupt row is repaired forward. `set_widget` also detects a governed `control_after_generate` control (side-effect-free) and warns that the written value will be overwritten on the next run; `graph_outline` annotates the widget. Verified by an independent 3-round adversarial codex review.
- **`panel_save_workflow` reports its Save-As outcome so a rename-vs-copy is never silent, with no false data-loss alarms (#579, #363).** The result now describes what happened (`saved_as` / `copied_from` / `original_on_disk` / `first_save`) instead of a bare `{saved:true}`, and a post-write disk check flags a genuine loss — while never false-throwing on a legitimate first save, a transient probe failure, a non-200 2xx pre-probe, a root-relative external path, or a tab switch during the pre-probe. The Save-As copy semantics themselves (never move/clobber the source) were already in place from #375; this locks the reporting around them. Naming a workflow created by `panel_new_workflow` is accepted as a first save (#363). Verified by an independent 3-round adversarial codex review.


## [0.11.21] - 2026-07-31

### Fixed
- **Save-As never clobbers or moves the original workflow (#285, #309, #289).** External-path Save-As writes with `overwrite:false` so an existing target returns a clean 409 instead of silently replacing/renaming the source, and the node-def cache is refreshed before `add_node` so a freshly-installed pack's nodes are addable. Live-verified on the rig against real ComfyUI: overwrite-refused → 409, original marker survived intact. (#375)
- **A run's completion event fires reliably even across a connection drop, and top-level prompt rejections surface (#358, #370).** `graph_run` now surfaces a top-level ComfyUI prompt rejection instead of hanging, and run reconciliation gives up only when the prompt is absent from BOTH `/history` and `/queue` — so a WS blip mid-render can no longer strand a running render or drop its completion. (#425)
- **`set_widget` fails closed on a removed or unverifiable node type (#458 set_widget gap).** A widget write against a node type that can't be verified via a fresh `/object_info` is now refused rather than fabricating success. (#423)
- **Promoted subgraph writes update the authoritative parent-rail widget (#366).** A write to a promoted widget syncs the parent rail (the source of truth), not just the inner node. (#383)
- **Unsaved-workflow tabs get a unique per-instance routing identity so graph edits never misroute (#186).** (#386)
- Ground unsaved workflows on every agent turn, disk-safely (#432).
- Live-geometry group membership after node moves (#355) + non-no-op revert (#327). (#431)
- `panel_update_node` reports a Manager task failure instead of false success (#364). (#382)
- Author/repo install shorthand, dead-collapse fallback, storyboard input litter. (#424)
- Consistent subgraph scope tracking + rail-id move + boundary cleanup + read/edit scope lockstep (#308, #302, #234, #220). (#373)


## [0.11.20] - 2026-07-30

### Fixed
- **Session rebinds/preserves the active tab across a tool-triggered reboot, soft reload, or `free_vram` (#278, #334, #207, #332, #310).** Resume the active session after a reboot (gated so a benign WS blip never bounces a live session, and an explicit Disconnect is never overridden); rehello the connected tab after `free_vram`; bounded retry of transient `Failed to fetch` during the reconnect window; `graph_load` replaces the active tab in place (no `Unsaved Workflow` spawn) and `workflow_list` dedupes tab records; the embedded ComfyUI `base_path` is advertised in the session hello. (#349)
- **panel_connect matches a valid `IMAGE→IMAGE` pair, and set_widget edges (#351, #179, #169; panel-side of #347).** `from_output` arriving JSON-stringified as `"0"` was read as a slot *named* `"0"` → 'no compatible pair' on a valid link; resolution is now name-first with a numeric-string→index fallback (#351). rgthree Power Lora composite widget values are parsed + merged instead of written verbatim (#179). Auto-match no longer clobbers an occupied dynamic-wildcard link (#169). `coerceWidgetValue` allows an explicit empty-string clear and rejects a genuinely-missing value (#347, panel side — the end-to-end empty-string fix also needs an orchestrator serialization change). Strict type-compat (#204) and combo/numeric strictness (#240) preserved. (#353)

## [0.11.19] - 2026-07-30

### Fixed
- **Run completion fires once on the authoritative lifecycle, with the full batch + correct duration + reliable resume (#293, #224, #200, #269, #468).** The completion `agent_event` was driven by a debounce timer, so it could flush mid-run (a partial image batch, a bogus `0.0s`/"no saved output node ran", or a previous run's output) and sometimes failed to resume the agent — leaving a TODO stuck. Completion now keys on the ComfyUI execution lifecycle for the specific `prompt_id` (flush on `execution_success`, full batch, real `execution_start→finish` duration), never flushes an active run, and never inherits a prior prompt's outputs. Mixed/multi-video runs emit exactly ONE combined event (stills + every video's storyboard folded into one `agent_event`, built in parallel with a per-video timeout so a stalled upload can't suppress completion) instead of a frame per output. Frame composition extracted to `web/js/lib/run-completion-frame.js` with headless tests. (#344)

## [0.11.18] - 2026-07-30

### Fixed
- **`graph_screenshot` captures node bodies under ComfyUI's Vue node renderer (#335, #329, #189, #237).** With `Comfy.VueNodes.Enabled` (default-on) node bodies are DOM/Vue elements layered over the LiteGraph canvas, so `toDataURL()` captured only the LiteGraph-painted wires/groups/HUD — screenshots showed zero nodes. Capture now forces the classic LiteGraph paint path by saving/restoring the live `LiteGraph.vueNodesMode` flag (not the async `Comfy.VueNodes.Enabled` setting), fits against CSS-pixel viewport dims, and saves/restores the active subgraph scope in a `finally` (#237). Live-verified on the rig with Vue nodes active: painted node-body pixels rose ~10× (0.34% → 3.52%) with the toggle, and `vueNodesMode` is restored after. (#341)
- **`panel_get_errors` no longer leaks stale missing-assets from another workflow tab (#316).** A missing-asset candidate whose recognized locator resolves to no node in the ACTIVE graph is now dropped, scoping errors to the currently-active workflow; unparseable/ambiguous locators still fail open so a genuine miss is never swallowed. (Widget-edit/appeared-on-disk staleness was already handled by the shipped #260 live recompute.) (#339)
- **`panel_set_widget` refreshes stale combo options before validating (#338, #317, #299, #288, #284, #304).** A just-downloaded model / uploaded image / staged output / freshly-installed pack value was refused against the frontend's cached combo list. On a combo rejection only, `set_widget` now awaits an authoritative `/object_info` re-register and revalidates exactly once against the fresh options — a genuinely-invalid value is still rejected (the #240 strictness is preserved). (#340)

## [0.11.17] - 2026-07-30

### Fixed
- **Error/tip messages no longer recommend the retired `panel_get_graph` tool (#318).** `panel_add_node`'s unknown-node-type error, plus several wiring/output-node/group-listing tips, pointed at `panel_get_graph`, which is no longer exposed. Unknown-node errors now point at `panel_search_nodes` (the node-type registry search), and graph-inspection tips point at `panel_query_graph` (the live-graph query that replaced the old full-JSON dump). Regression test asserts the unknown-type message never references the retired tool.

## [0.11.16] - 2026-07-30

### Fixed
- **Group tools report live, accurate membership instead of a stale/empty snapshot (#311, #312, #287, #297, #305).** LiteGraph group membership is purely geometric (a node belongs to a group when its bounds overlap the group's bounds) and has no per-node ownership, but the panel trusted the stale `group._nodes` cache — so members read empty after grouping pasted nodes (#312), went stale after moving nodes in/out or resizing (#287, #311, #305), and `create_group(node_ids)` could silently enclose unrelated neighbors in dense layouts (#297). A new `groupMemberNodes()` recomputes membership from live geometry on every read (edge-inclusive overlap mirroring LiteGraph's `overlapBounding`), routed through all read sites plus `graph_move_group` and auto-layout. `graph_create_group` builds a bounding box tight to exactly the requested nodes and reports honestly — `requested_node_ids` / `extra_node_ids` / `missing_node_ids` with a warning whenever geometry differs from the request, instead of silently mis-reporting. Live-verified on the rig: create-around-two-nodes returns exactly those two (third excluded); moving the third node into the group region re-reports it as a member. (#320)

## [0.11.15] - 2026-07-30

### Fixed
- **Chat context no longer reaches the agent as the literal `[object Object]` (#276).** The real culprit was not attachments (those already travel over structured image/text channels) but the `{workflow, subgraph}` **context object**, which `sendUserMessage` `Array.join`-coerced to `[object Object]` and the orchestrator prepended above every user message (a regression from the transcript-replay change). A new `serializeContext()` renders it to readable text (`Workflow: <name>` / `Viewing subgraph: <name>`, JSON fallback for unknown shapes, string passthrough for transcript replay). Outbound image descriptors are normalized at the wire choke-points and every other plausibly-object outbound/inject field is routed through `coerceMessageText`. Live-verified on the rig: the agent now receives `"Workflow: <name>"` instead of `[object Object]`. (#313)
- **Hardened the ordinary-card replay path** so structured panel messages can never render as `[object Object]` (#272 was already handled on main for the say/agent/card-reply paths; this closes the remaining replay sink).

## [0.11.14] - 2026-07-30

### Fixed
- **`panel_search_nodes` degrades gracefully against an unreachable or legacy ComfyUI-Manager (#251, #255).** Node search called the dialect-routed `customnode/getmappings` and threw `ComfyUI-Manager not reachable` whenever the built-in Manager was disabled or was an older/partial 3.x build — blocking the whole install-discovery flow. It now retries the absolute (no-`/v2`) legacy route on an unreachable/404 signal, and returns a structured `{supported:false, managerReachable:false, results:[]}` result (pointing at `panel_list_nodes`) instead of a raw throw when both routes are unreachable. Genuine server errors (500/403) still propagate. Logic extracted to a dependency-injected `searchNodesVia` so the unit tests exercise the real decision path. (#294)

## [0.11.13] - 2026-07-30

### Fixed
- **SEVERE: write tools no longer fabricate success when the target can't be resolved (#458).** `graph_add_node` and `graph_set_widget` could return a plausible success payload — a full node schema, a "set" result — even when ComfyUI was unreachable, the node type was unknown, or the resolved target was a stale/unregistered placeholder, silently misleading the agent into thinking a write landed. Both tools now fail closed: `add_node` runs `assertAddNodeResolvable` before `LG.createNode` (distinguishing unreachable / defs-not-loaded from a genuinely unknown type via Comfy core sentinel types), and `set_widget` runs a resolved-target registration guard (`assertResolvedTargetRegistered`) *before* any coercion, hook, mutation, or widget callback — refusing type-less nodes, unresolved `subgraph:{}` placeholders, and stale instances while still trusting native/defless types (Note/Reroute). Shared handler extracted to `lib/set-widget.js` so the unit tests drive the exact production path. Live-verified: an unknown node type errors instead of returning a fabricated schema; a real node (KSampler) still succeeds with its true schema. (#281)

## [0.11.12] - 2026-07-30

### Fixed
- **Copy/paste no longer SILENTLY drops unregistered node types (#261).** Pasting a graph that contains node types not registered on the current server (e.g. AudioCrop / AudioSeparation) used to lose them with no signal. `graph_paste_nodes` now diffs the clipboard against what actually landed (byte-identical-fingerprint-guarded snapshot fallback) and returns `dropped_nodes`/`dropped_types` + a clear warning, so the agent knows which nodes were dropped instead of silently continuing. (#275)

## [0.11.11] - 2026-07-30

### Fixed
- **Regression: saving a brand-new workflow was broken on ComfyUI frontend 1.47.x (#268).** The 0.11.6 #226 data-loss guard routes the safe path through `svc.saveWorkflowAs`, which the 1.47 frontend removed from `extensionManager.workflow` — so the guard fail-safe refused and `panel_save_workflow` could not save any never-persisted workflow (no data loss, but the flow was dead). `resolveSaveAsCopy` now probes the copy API across frontends — `saveWorkflowAs` (1.45.x) or `saveAs`+`openWorkflow`+`saveWorkflow` (1.47.x, mirroring upstream's Save-As sequence so the copy is activated and its real graph is persisted, never `null`); and `classifySource` consults an authoritative `/userdata` filesystem oracle (404-only ⇒ never-persisted) to distinguish a genuinely-new tab from a drifted real file, which 1.47's in-memory store can't. The #226 invariant is fully preserved (a real on-disk source is never moved/destroyed). Live-verified: a new workflow saves real content; a save-as still preserves the original. (#273)

## [0.11.10] - 2026-07-30

### Fixed
- **panel_get_errors no longer reports a stale missing-asset for a SUBGRAPH-hosted node after the asset is fixed.** Root-node missing-assets already recomputed live (WS-3), but a subgraph node's candidate id is a NodeLocatorId `<subgraphUUID>:<localNodeId>` (the first segment is the subgraph's global UUID, not a host node id); the previous resolver walked it as host ids, never resolved, and the live cross-check failed OPEN — so a subgraph LoadImage/checkpoint/template asset kept being reported missing even after a `set_widget` fixed it (#247, and the subgraph parts of #235/#257). `findNodeByScopedId` now resolves the locator the way ComfyUI's `getNodeByLocatorId` does (strict two-segment parse + UUID validation + cycle-safe subgraph lookup); malformed locators still fail open so genuine misses are never suppressed. (#260)

## [0.11.9] - 2026-07-30

### Fixed
- **Complete the ComfyUI-Manager 3.x legacy dialect for restart / update-self / list.** A legacy Manager (released 3.x, or a pip build in `--enable-manager-legacy-ui` mode) serves reboot ONLY at `POST /manager/reboot`; the previous candidate list tried `POST /v2/manager/reboot` (405) then `GET /manager/reboot` (404), leaving a legacy Manager unrestartable (panel #214). `panel_restart_comfyui` now picks the reboot route by detected dialect (legacy → `POST /manager/reboot` first; v2/pip unchanged). Also: `panel_update_node` retries the absolute legacy `POST /manager/queue/update` on a `405` when updating ComfyUI-Manager itself, and `panel_list_nodes` falls back to the absolute `/customnode/installed` when a legacy build answers the `/v2` queue probe but not the `/v2` data GET. v2/v2-batch happy paths unchanged. (#250)

## [0.11.8] - 2026-07-30

### Fixed
- **SEVERE: `panel_install_node` no longer silently reports success without installing (#232).** ComfyUI-Manager marks every queued task "done" even when the git clone fails, and its status surface exposes only aggregate counts — so a GitHub-repo install that never landed reported identically to a real success. Install now goes through a tri-state verifier: **installed** only on a positively-observed queue drain + the pack actually present in `/customnode/installed`; **failed** only when the queue drained with readable data, explicit failure evidence, and an identifiable target definitively absent; **unverified** (honest `pending`, never a false success or false failure) for everything else — a rename-prone install (git URL / `owner/repo` whose on-disk dir differs), a still-processing queue, or a malformed/unreadable status or installed-list. Every Manager request (dialect probe, install, start, status, list) is now timeout-bounded. Live-verified: a bogus git-URL install returns `installed:false, verified:false, pending:true` with no false success and no crash. (#246)

## [0.11.7] - 2026-07-30

### Fixed
- **SEVERE graph corruption: `panel_set_widget` on a promoted subgraph widget + combo enums (#233, #240).** `graph_set_widget` did `w.value = value` with no target resolution or value validation. On a SubgraphNode the promoted widget's slot is positionally shifted vs the inner node, so writing by name clobbered a DIFFERENT inner widget (an INT `steps` slot ended up holding `"euler"`) while reporting success; and a combo write was later reinterpreted as a stale dropdown index, drifting to a neighbouring enum. New `web/js/lib/widget-write.js`: `resolvePromotedInnerTarget` walks the subgraph-input link to the ACTUAL inner `(node,widget)` and FAILS CLOSED (throws before any mutation) when a promoted widget can't be resolved or is ambiguous — never writing a shifted parent slot; `coerceWidgetValue` validates by declared type (combo = exact current option only, numeric rejects arrays/objects/blanks/non-finite) and the handler verifies the value stuck exactly. Live-verified: a valid combo value sets exactly, an invalid one is rejected (not silently coerced). (#244)
- **`[object Object]` at the sidebar + persisted-replay sites (#238, #241).** WS-9 (#228) serialized the live chat but the sidebar output payload and the persisted-message rehydration path still stringified objects. Both now route through the shared `coerceMessageText`; replay drops only content-losing objects, never a legitimately empty message. Live-verified after reload. (#243)

## [0.11.6] - 2026-07-29

### Fixed
- **SEVERE data loss: save-as must never move a persisted source (#226, reopened).** The
  earlier #231 fix trusted the frontend's `saveWorkflowAs` to copy, but on comfyui-frontend
  1.45.21 that call MOVES a source flagged temporary — and a `panel_open_workflow` ack-timeout
  race (#215) can leave a real on-disk workflow flagged temporary, so `save_workflow({name})`
  silently deleted the original. `saveActiveWorkflow` now classifies the source by ACTUAL
  on-disk state (tri-state: persisted / never-persisted / unknown; only a null oracle result or
  a doc with no path proves absence — a returned object, a thrown lookup, or a list-miss all fail
  safe) and REFUSES any rename/move of a persisted-or-unknown source; a persisted save-as copies
  with the source verified surviving; an empty/unresolved target can no longer be recomputed into
  a move. Verified by 238 unit tests + a Chrome live-test (the exact repro that destroyed a file
  under #231 now preserves it). (#239)
- **Chat media persistence + structured-payload serialization (WS-9).** Inline chat images/video
  survive a panel reload, and structured error/user payloads render as readable text instead of
  `[object Object]`. (#228)
- **Invalidate stale caches/snapshots after a restart+edit (WS-3).** Graph tools see the live
  graph after a restart instead of a stale snapshot. (#227)
- **Stop leaking typed-message image attachments in Blind mode (#174).** (#217)
- **Route panel node ops by Manager generation (#187, #182, #184).** The
  built-in Manager helpers hardcoded the `/v2/manager/queue/task` envelope, so
  `panel_install_node` / `panel_update_node` returned HTTP 405 against Manager
  v4 in legacy-UI mode (`--enable-manager-legacy-ui`, #187) and against the
  released ComfyUI-Manager 3.x (#182). Added `detectManagerDialect()` (probes
  `/v2/manager/queue/status` + `/v2/manager/is_legacy_manager_ui`, falls back to
  `/manager/queue/status`; cached per session) and a `managerCall()` sibling
  that hits absolute (non-`/v2`) routes. Install/update/queue-status/list/search
  now pick per dialect: `v2` (unified task envelope), `v2-batch` (POST
  `/v2/manager/queue/batch` with 3.x body shapes), or `legacy` (per-operation
  `/manager/queue/*`, no `/v2` prefix). Mirrors the mcp orchestrator's
  `detectManagerApi`.
- **`panel_install_node` no longer silently no-ops (#184).** On the batch
  dialect it now inspects the `{failed:[...]}` response and throws when the
  target pack failed instead of reporting a queued success — the rgthree-comfy
  case where the queue drained "done" but the pack never hit disk. The queued
  note also tells the agent to VERIFY with `panel_list_nodes`.
- **git-URL installs send valid per-dialect payloads.** A full git URL was
  being placed in `id`, which resolves to nothing on v4 (queue silently marks
  "done") and fails late on 3.x (past the immediate `failed` array). Now the
  repo NAME is derived from the URL: v4 installs by `{id: repoName,
  selected_version: ref||"nightly", channel: "dev"}` (no `files`); v2-batch and
  legacy install the URL natively via `{id: repoName, version: "unknown",
  files: [url]}`. Registry-id installs are unchanged. Recognizes every git
  protocol (`https://`, `ssh://`, `git://`, `git+…`, scp-form
  `git@host:owner/repo`, and `.git` suffix) whether the URL arrives via `id` or
  `repository`. The routing helpers were extracted to
  `web/js/lib/manager-install.js` with `node --test` unit coverage.
- **Pre-empt the coming comfy-cli hard error.** Publishing already warns that
  "we will soon disable exec and eval, and multiple statements in a single
  line"; when that lands it breaks `Publish to Comfy Registry`, i.e. we'd find
  out at release time. Split the four semicolon-joined lines in the brand-asset
  scripts and turned a `seg = lambda` into a `def`. No exec/eval existed
  anywhere, and the shipped `__init__.py` / `py/*.py` were already clean.

### Added
- CI step enforcing comfy-cli parity (no exec/eval, no multi-statement lines).
  AST-based rather than grep — a `;` search matches semicolons inside string
  literals and reported false positives on every `py/` file.

### Changed
- **Registry tags now claim the local/offline story.** The listing advertised
  Claude/ChatGPT/GPT-5 but nothing about running locally, so a user browsing
  ComfyUI-Manager for a self-hosted option had no way to find it. Adds `local`,
  `local-first`, `offline`, `self-hosted`, `ollama`, `local-llm`, `no-api-key`,
  and `gemini` — the differentiators against a cloud-only agent.

### Added
- **Chat archive UI** — multiple named or pinned conversations per workflow,
  workflow-grouped search and filtering, JSON merge import/export, explicit
  Panel / Workflow / Ask-on-switch scope modes, provider/model metadata, and
  per-user-message workflow-version context. Missing provider sessions continue
  from a bounded transcript replay. Portable imports cannot carry foreign
  sessions, checkpoints, tombstones, or active pointers into local history;
  provider-mismatched sessions start fresh with bounded transcript hydration.
  Import is add-only on colliding IDs and fails closed at thread/message caps
  instead of evicting local history. Materialized metadata maps are bounded, and
  an IndexedDB outage now warns when the small localStorage shadow is incomplete.
  Legacy shadow-only transcripts are never silently truncated by those caps.

## [0.11.0] - 2026-07-22

### Added
- **Micro-apps — turn a workflow into a one-click app.** A WeChat-mini-program-style
  layer over ComfyUI APP mode, with panel and mobile parity. App bundles live under
  `user/comfyui-mcp-panel/apps/` (manifest + UI workflow + API prompt snapshot +
  thumbnail); the run engine patches `<nodeId>.<widget>` into the snapshot and queues
  it. Includes the AppBuilder (APP-mode config import, heuristic input/output
  selection, dependency scan), a My Apps grid with a generated run form and output
  gallery, **Run on RunPod** (dry-patch, then enqueue on the connected pod with
  pinned deps pushed first), and a Publish / Explore registry with trending, new,
  stars, search and install. (#114)
- **Hover a truncated label to read the rest of it.** An ellipsis hides the END of a
  string, which is usually the identifying part — a quantisation suffix, an Ollama
  size tag, a date. Hovering a clipped element now scrolls it to its end and hovering
  away restores the truncation. Delegated from the panel root, so it covers popover
  rows, the model chip, download and attachment names, pending text and card text —
  including elements rendered later. Honours `prefers-reduced-motion`. (#120)

### Fixed
- **The settings dropdown no longer closes itself.** Connection status drove the
  visibility of that box, and the bridge re-emits `connected` on every handshake
  frame — so opening the menu while connected got it slammed shut by the next tick,
  putting **Disconnect out of reach entirely**. Status no longer owns that
  visibility: the dropdown opens and closes on user intent only (trigger, click-away,
  Escape, or API Keys). Escape-to-close is new — the box never had a keyboard
  dismissal. (#116, #117)
- **The model chip stays on one line at any panel width.** It had no wrapping rules,
  so a squeezed chip broke across two lines and pushed the composer row taller. The
  model name now ellipsises instead, keeping a floor so it never truncates to
  nothing, with the effort suffix yielding first and the full value on the title of
  the chip. (#118)
- **A reboot behind a proxy is no longer reported as a failure.** When ComfyUI is
  reached through a reverse proxy or Cloudflare tunnel, killing the origin returns a
  gateway error rather than dropping the connection, so a reboot that actually FIRED
  was misreported and remote agents concluded "restart failed". 502/503/504 are now
  classified exactly like the connection-drop success branch. (#119)

### Security
- **Bridge auth tokens are no longer printed to the panel log.** Three status lines
  echoed the full bridge URL including `token=<64 hex chars>`; those lines get
  screenshotted into bug reports and pasted into chats. Only the first four
  characters now survive. The same change wraps long status lines
  (`overflow-wrap: anywhere`), since an unbreakable 64-char token was also forcing a
  horizontal scrollbar across the whole log. (#121)

### Internal
- **CI actually runs again.** The Bandit step had been failing since the micro-apps
  merge, and because it runs before the YARA and pyproject checks, those three were
  being **skipped** on every run — the registry-parity gate was not being enforced,
  not merely reported red. Both findings were false positives: a test used a literal
  `/tmp` path (now `tempfile.gettempdir()`, which also fixes the test on Windows),
  and a wildcard-bind comparison that exists precisely to rewrite the bind to
  loopback is marked `# nosec` with a reason. (#122)


## [0.10.0] - 2026-07-22

### Added
- **RunPod control panel** (`cmcp-runpod-ui.js`) — a toolbar host pill that
  reads **🟢 Local** or **🔵 RunPod** and opens a control modal: live status
  card (pod / GPU / VRAM / uptime / $·hr / ComfyUI URL / idle auto-stop
  countdown), a **pod dropdown that lists your pods by name** (with refresh +
  manual-ID fallback), Connect / Start / Stop / **Use Local**, and a
  confirm-armed **Deploy** that routes through the referral deploy link. Driven
  by the orchestrator's `runpod_status` + `comfyui_target` broadcasts and the
  whitelisted `runpod_*` tools, so where a render runs is never ambiguous.
  (requires comfyui-mcp >= 0.44.0)

### Fixed
- CivitAI browser: the **base-model filter is now complete and searchable**, and
  the composer is uncrowded (#108, #110).

### Added
- dock + slide the three toolbar side-panels; CivitAI share closes + right-aligned actions (#113)
- agent-drivable CivitAI + training modals with side-dock + green highlights (#112)
- RunPod control panel + honest host indicator (#100)
- Local/Pod target switch in the training wizard (P4) (#109)
- Antigravity (Google subscription) provider chip (comfyui-mcp#262)
- docs wordmark in the panel header; chat bubble back in the sidebar (#105)
- LoRA training wizard — dataset gather/label + launch/monitor (panel) (#96)

### Fixed
- defects in the base-model filter found reviewing #108 (#110)
- uncrowd the composer; make the base-model filter complete and searchable (#108)
- _antigravity_installed honors COMFYUI_MCP_ANTIGRAVITY_PATH (comfyui-mcp#271)
- render each slot's help text in the API Keys card (#103)
- crop, centre and whiten the header wordmark (#107)


## [0.9.9] - 2026-07-20

### Changed
- Registry listing refresh: display name is now **ComfyUI MCP | Agent Panel**,
  the description is rewritten local-first in pure ASCII (the old text carried
  double-encoded em-dashes that rendered as mojibake on registry.comfy.org),
  and the icon/banner are the flat comfyui-mcp mark shared with the docs site
  and mobile app — the sidebar tab wears the same mark (#99)


## [0.9.8] - 2026-07-20

### Fixed
- **Blind is now a real guarantee** (#90): the toggle rides the hello and a
  live set_content_mode frame so the orchestrator withholds pixels from ALL
  of the agent's image tools (requires comfyui-mcp >= 0.42.0), and
  graph_screenshot refuses under Blind — previously only the panel's own
  image feed was gated

### Fixed
- send content mode to the orchestrator + gate screenshots (fixes #90) (#97)


## [0.9.7] - 2026-07-20

### Changed
- Codex/ChatGPT reasoning-effort scale extends to `max` and `ultra` for the
  GPT-5.6 family (per-model ceilings still intersect with the model list —
  Luna tops out at `max`); pairs with comfyui-mcp >= 0.41.0

### Added
- max + ultra on the Codex scale for GPT-5.6 (#94)


## [0.9.6] - 2026-07-19

### Fixed
- announce missing assets at turn start, not just on request (#93)

### Changed
- merge graph_view_errored_nodes into graph_get_errors (#92)


## [0.9.5] - 2026-07-19

### Fixed
- carry exception_type, and surface runtime failures in the affordance


## [0.9.4] - 2026-07-19

### Fixed
- correct the missing-node-types source; fall back for validation errors


## [0.9.3] - 2026-07-19

### Fixed
- stop tripping the YARA SUSP_SVG scan


## [0.9.2] - 2026-07-19

### Added
- view_selected / view_nodes_in_viewport / view_errored_nodes (#91)


## [0.9.1] - 2026-07-18

### Added
- add Kimi K3 (Moonshot) provider chip (#89)


## [0.9.0] - 2026-07-17

### Added
- **LoRA Training modal** (mobile-app parity): a Training button next to
  Civitai in the panel toolbar opens a coming-soon preview — six training
  flows (Image Character/Edit/Style/Slider, Video Character/Action) as cards
  with base-model dropdowns (Krea2/Flux2/ZImg, Qwen Edit 2509, LTX 2.3/
  Wan 2.2), under a Local/Cloud switch. Local shows the rig's REAL GPU from
  `/system_stats`; Cloud (RunPod) previews the token field for the future
  headless trainer. Fixed-height modal, header pinned, card grid scrolls
- Settings → Mobile app (beta): the iOS TestFlight and Android Firebase
  App Distribution buttons are LIVE invite links (no more "coming soon")

### Fixed
- **CivitAI Favorites shows ALL your likes**: the feed now reads your likes
  COLLECTION (auto-detected from your account when none is picked, shared
  with the ❤ mirror; reactions fallback) — image reactions only hold hearts
  made in-panel, while the website's ❤ saves into the collection, so the tab
  previously showed a handful instead of the full list
- CivitAI pagination is boundary-safe and never dead-ends: cursors continue
  from the last received item (the server's echoed cursor silently dropped
  one liked item per page), appends dedup by id, EVERY tab tops itself up
  when a page doesn't overflow the modal (a short first page previously left
  the scroll sentinel unreachable — the list just stopped), and the lightbox
  pages immediately when opened on one of the last items
- The provider chips, connect help, empty-state hero, and tooltips no longer
  hardcode Claude — they follow the active backend (provider-agnostic copy)

### Fixed
- CivitAI browser filters actually respond: chips re-render on click (the sheet
  wired a rerender hook that was never defined, so they looked dead), and the
  level/base-model toggles no longer mutate the frozen module defaults
- CivitAI lightbox no longer claims "✓ Embedded ComfyUI workflow" for posts
  whose `meta.comfy.workflow` is the empty `{}` civitai sometimes emits — it
  now falls back to the API-format prompt (savable) and says which one it found

### Added
- CivitAI browser: **"See more from @creator"** in the lightbox and model
  detail, and **GitHub-style search qualifiers** — "@name terms" sets the
  creator filter (the displayed @token always owns it; deleting it clears)
  while the terms stay ranked full-text search (#86)
- CivitAI browser: **Load workflow onto canvas** (community request from
  Discord). In the lightbox, a post with an embedded UI-format ComfyUI graph
  gets a "Load onto canvas" action: confirm-overwrite when the current
  workflow has unsaved changes, then load through the same undoable path the
  agent bridge uses (snapshot → `loadGraphData` → change-tracker `checkState`,
  so one load = one Ctrl+Z). API-format-only posts say so honestly instead of
  corrupting the canvas (Save still keeps their JSON — there is no client-side
  API→UI converter). On the Workflows tab, model versions grow a
  "Load workflow onto canvas" button per downloadable workflow file: raw
  `.json` loads directly; civitai's `.zip` wrappers (780 of 844 live versions)
  are unpacked in the browser (central-directory walk +
  `DecompressionStream("deflate-raw")`, no new dependency) with a picker when
  an archive holds several workflows, under zip-bomb caps (entry count,
  per-entry and aggregate uncompressed size — a lying size header is
  re-checked after inflation; duplicate directory records aimed at one blob
  are deduped). Downloads stream through a new same-origin proxy route that
  follows civitai's 307 server-side with an SSRF guard — only https civitai
  download CDNs (civitai/B2 **and** civitai's signed Cloudflare R2 delivery
  worker, where signed-in downloads land) whose every DNS answer is a public
  address (no loopback/RFC1918/link-local/metadata, no rebinding), OAuth
  header dropped on the cross-host hop — streaming through (no buffering)
  with a 100MB cap.
  Gated files (civitai 307s the download to `/login?…reason=download-auth`,
  even on some "Public" versions) are detected deterministically and return a
  clean 401, and every download/parse/empty/API-only outcome is surfaced BOTH
  as a top-of-stack toast and an inline status line in the version sheet
  (which stays open) — with a one-click "sign in" for the gated case — so the
  action is never a silent no-op. A load reporting zero nodes is treated as a
  failure (the explorer stays open) rather than a phantom success. The
  overwrite-confirm dirty check fails CLOSED (unknown workflow state ⇒ ask),
  and the load is awaited so success/undo bookkeeping only fires once the
  graph actually landed
- CivitAI browser: **Creator filter** in the filter sheet (parity with the
  mobile app) — an empty field shows the site's top-creators leaderboard
  (ranked, with download/like counts; degrades to a friendly note when the
  endpoint balks), typing runs a debounced username search, and the picked
  creator becomes a removable pill that narrows every feed: images/videos
  (`/v1/images?username=`), media search (Meili `user.username` filter,
  escaped), and model tabs (`/v1/models?username=` — keyword+creator matches
  the keyword client-side around an API quirk). Favorites shows the filter as
  visibly ignored (your likes come from every creator); Reset clears it
- CivitAI browser: **like/unlike toggle** — heart on card hover and in the
  lightbox (signed out, the heart opens sign-in); likes mirror into a **default
  likes collection** picked (or created) in the new account sheet
- CivitAI browser: sub-nav under the tabs with **debounced (500ms) search on
  every tab** (Meili for media, REST query for models, client-side for
  favorites) behind a blur+spinner overlay; **Favorites shows ALL your likes**
  (no browsing-level gate on your own reactions) with All/Images/Videos filter
  chips; all feeds page 100 at a time with scroll auto-load
- CivitAI OAuth scope now includes SocialWrite + CollectionsRead (reactions and
  collections 403'd under the old scope — existing sign-ins re-consent once)
- CivitAI browser: clicking an image/video opens a full-screen LIGHTBOX — media
  on the left, details on the right (author, stats, prompt/negative, parameters,
  share-with-agent / save-workflow actions), with arrow-key/wheel paging and Esc
- **panel-owned sessions (default)** — the conversation and agent memory now
  persist while you switch, save, rename, or create workflows; the agent is
  mechanically told which canvas it operates on (one-shot context, no memory
  tools). The live agent instance is rebound across tab ids (no respawn), so
  even in-memory local backends keep their history. Settings → General →
  "Conversation follows the panel" restores the legacy per-workflow mode

### Changed
- the agent-feed gate is now **Deafen** (was Mute), with ear / slashed-ear icons —
  "deafen" says what it does (the agent stops HEARING canvas events; your typed
  messages still go through), the old speaker icon read as audio mute. The saved
  setting carries over (same storage key).

## [0.8.2] - 2026-07-14

### Added
- graph_serialize command — full-fidelity live-canvas capture

### Fixed
- replace expired invite with the permanent link (#82)


## [0.8.1] - 2026-07-14

### Fixed
- keyed-provider hints lead with the API Keys card; custom endpoint advertises DeepSeek BYOK


## [0.8.0] - 2026-07-12

### Added
- utility strip (header row 2) — Mute/Blind move off the composer; Civitai explorer parked
- Clear button on credential slot rows — revoke a saved key (comfyui-mcp#203)
- A2UI chat cards — validated interactive UI cards in chat (lit renderer) — ported from MichaelDanCurtis fork (#79)
- per-workflow agent sessions + provider on/off + thread rename migration — ported from MichaelDanCurtis fork (#80)
- Grok + Kimi providers, in-panel OAuth sign-in, experimental-backend gating — ported from MichaelDanCurtis fork (#81)

### Fixed
- QR encodes the https lander URL — phone cameras refuse ws:// ("No usable data found")


## [0.7.3] - 2026-07-09

### Added
- the agent now keeps working when you switch to another sidebar tab (Assets,
  Queue, …) — the panel detaches instead of tearing down, so the connection,
  session, and chat survive; replies that land while you're away are waiting
  when you come back
- agent activity badge on the sidebar tab icon: green spinner while a turn is
  in flight, red dot when it finished while you weren't looking (clears on
  open), plain chat glyph when idle

### Fixed
- rapid sidebar tab switching no longer causes any bridge reconnect churn —
  the panel is built once per page instead of once per tab open


## [0.7.2] - 2026-07-09

### Fixed
- the "Control via Mobile app (beta)" gate now actually hides the header QR
  button when off — the `hidden` attribute was overridden by the icon-button's
  `display: flex` CSS; switched to inline display toggling


## [0.7.1] - 2026-07-09

### Added
- "Remote control" QR — pair a phone (LAN default / Internet opt-in) (#78)
- Settings: "Control via Mobile app (beta)" toggle (default off) gating the QR
  pair button, plus "Get the beta app" tester links (iOS TestFlight / Android
  Firebase App Distribution — buttons show "coming soon" until channels open)

### Fixed
- bridge-driven graph mutations are now actually undoable — the dispatcher
  registers each successful command with ComfyUI's ChangeTracker
  (checkState()), so one command = one Ctrl+Z step
- e2e suite is hermetic on dev boxes (13/13): fixtures stub orchestrator
  discovery + panel settings so a live agent can't hijack specs or have its
  settings polluted by them


## [0.7.0] - 2026-07-09

### Added
- graph_auto_layout — topological auto-layout with group + reroute handling,
  barycenter ordering, dry-run planner; pure engine module in web/js/lib/ (#75)
- graph_connect auto-match by type + full slot diagnostics on failure —
  wildcard/COMBO/widget ranking, ambiguity guard, replaced_link reporting (#76)
- graph_query executor — filter/traverse/aggregate the live canvas (#169 panel side) (#77)
- Custom endpoint chip + Settings, all token buttons agent-free (#162 panel side) (#74)
- llama.cpp backend chip + setup card (#161 panel side) (#73)

### Fixed
- comboSignature — text-safe NUL separator; raw NUL byte made git/scanners treat the bundle as binary
- clear both Python findings from the release scan (#72)


## [0.6.9] - 2026-07-09

### Added
- LM Studio backend chip + setup card (#160 panel side) (#71)
- Discord + Need-help buttons + version-sync guard (recover stranded 0.6.8) (#68)

### Fixed
- Fable 5 was invisible — dedupe pinned claude-* ids by resolvedModel, not pattern (#70)


## [0.6.8] - 2026-07-08

### Added

- **Discord community + one-tap "Need help?" in Settings → About.** Alongside
  ⭐ Star on GitHub there's now **💬 Join the Discord** and a **🆘 Need help?**
  button that copies a short diagnostics summary (panel version, backend,
  ComfyUI version, page URL, user-agent) to the clipboard and opens the Discord,
  so a stuck user pastes exactly what's needed to help fast. README links the
  Discord too. Invite: https://discord.gg/TtQpf96BHS

### Changed

- **Panel version can no longer drift out of the diagnostics blob.** The JS
  `PANEL_VERSION` is now bumped together with `pyproject.toml` via
  `node scripts/set-version.mjs <v>`, and CI + the publish gate FAIL if the two
  disagree — a stale version can't be shipped.

## [0.6.7] - 2026-07-08

### Changed

- **Local (Ollama) backend now defaults to the fine-tuned `gemma4-comfyui-mcp`
  ladder**, with a one-time migration of the stale `gemma4:e4b` default to the
  fine-tune. (#62, #66)

## [0.6.6] - 2026-07-08

### Fixed

- **Switching to an already-open workflow tab (`panel_open_workflow`) left the
  canvas frozen on the previous graph, and earlier attempts corrupted tab
  buffers.** Root cause (confirmed by live in-browser debugging): the frontend
  store's `openWorkflow` sets the tab *active* but does **not** load the graph
  onto the canvas — that repaint normally rides the frontend's workflow
  *service* tab-switch, which the panel can't reach (it's a Vue composable, not
  exposed on the store or `window`). So switching among open tabs showed the
  wrong graph (#65), and prior in-place-load workarounds clobbered a tab's live
  buffer, where a Save would then overwrite the good file (#63, #64). Fix: after
  `openWorkflow`, force the repaint the way a real tab-click does — load the
  target's own live buffer (`changeTracker.activeState`, so unsaved edits are
  preserved, not the on-disk copy) into **its** tab via
  `app.loadGraphData(state, true, true, target)` (the 4th arg associates the
  load with the target so no duplicate "Unsaved Workflow" tab spawns). Verified
  live: switching among 12/39/126-node tabs repaints correctly each time with no
  duplicate tabs and no cross-tab clobber. NOTE: `getWorkflowByPath` returns the
  *same object* as the open-tab instance, so the `find()` reorder proposed in
  #63 was a no-op red herring (it only regressed switching, per #65) — reverted
  and not shipped.

## [0.6.5] - 2026-07-07

### Fixed

- **Clicking a chat image on a remote pod opened a blank tab.** Bridge-delivered
  images arrive as `data:` URIs, and Chrome blocks top-frame navigation to
  `data:` — the zoom click's new tab stayed on `about:blank`. Data URIs are now
  re-wrapped as same-origin `blob:` URLs before opening (plain `/view` URLs on
  local ComfyUI are unaffected).

## [0.6.4] - 2026-07-07

### Fixed

- **Ctrl+C never interrupted the agent when focus sat outside the panel.** The
  interrupt hotkey listened on the panel root in bubble phase, so clicking the
  chat log or the canvas (focus on `<body>`) made the shortcut silently do
  nothing. It now uses a document-level capture listener gated to a turn in
  flight, with **Esc** added as a second stop key. Guards keep the global scope
  polite: Ctrl+C never steals a real copy (text selection and selected graph
  nodes win), Esc defers to the composer menu, ComfyUI dialogs, and editable
  fields outside the panel, and the listener is removed on destroy so remounts
  can't stack it. The thinking label now reads "(Esc or Ctrl+C to stop)". (#61)
- **Onboarding card never hid once shown.** The `.cmcp-onboard` base rule's
  `display:flex` beat the UA's `[hidden]` rule by cascade, so readiness updates
  that set `hidden` had no visual effect. `display:none` is now re-asserted
  under `[hidden]`, matching the existing overrides in the stylesheet. (#59,
  #60)

## [0.6.3] - 2026-07-06

### Fixed

- **Registry security-scan: stop shipping this changelog in the published
  archive.** The Registry's private YARA scan matches code-shaped literals in
  ANY file of the uploaded zip — markdown prose included. 0.6.2 (which cleared
  the SUSP_SVG tokens) was still flagged `any-code-execute` because THIS file's
  0.3.x-era entry quoted, verbatim, the process-spawn call that entry was
  documenting the removal of. `CHANGELOG.md` is now `.comfyignore`'d (it
  documents security fixes, so it will always contain such literals), and CI +
  the publish gate scan every file that still ships for process-spawn literals.
  The three remaining scanner findings (env-var reads, the local orchestrator
  port probe, and the panel's WebSocket client) are info-severity and intrinsic
  to what this pack is; per the scanner's design any finding queues the version
  for manual review, which is being requested separately.

## [0.6.1] - 2026-07-06

### Fixed

- **Reconnect wedged forever on a remote pod's `wss://` secure bridge.** On an
  https pod page, if a tab's first autoconnect raced the orchestrator's advertise
  of the secure tunnel URL (e.g. right at orchestrator startup, or a background
  tab that was already retrying before this orchestrator came up), it fell back
  to the plain unauthenticated `ws://127.0.0.1:<port>` default. Contrary to this
  file's own long-standing assumption, Chrome does **not** mixed-content-block a
  `ws://127.0.0.1` dial from an `https://` page (loopback is exempt) — so that
  fallback actually reached the real local bridge directly and got rejected for a
  missing token, then retried that SAME wrong URL forever (capped at 15s) with no
  way back to the correct tunnel short of a manual Reconnect. The reconnect loop
  now re-fetches the advertised bridge URL on every retry and switches over the
  moment one becomes available, self-healing without user action.

## [0.4.13] - 2026-07-01

### Changed

- **The connect command now prefills THIS pod's own URL on https pages** (help
  dropdown, onboarding step, no-agent hint) — e.g.
  `npx -y comfyui-mcp@latest connect https://<this-pod>`, read from
  `window.location`. Running it with the URL lets the orchestrator open a secure
  `wss://` bridge that works in **every browser** (Safari / Firefox / Comet), not
  just Chrome-with-a-prompt. Composes with the per-shell copy block (0.4.12); bare
  form still shown on http/localhost. Pairs with comfyui-mcp 0.23.4.

## [0.4.12] - 2026-07-01

### Changed

- **Per-shell copy for the `connect` command.** The Settings connect help and the
  onboarding "start the agent" step now offer the command as **three labeled copy
  buttons — PowerShell, Command Prompt, macOS / Linux** — with your detected OS
  preselected. PowerShell copies the `cmd /c "npx -y comfyui-mcp@latest connect"`
  form (which sidesteps the `npx.ps1` execution-policy trap), while Command Prompt
  and bash/zsh copy the bare `npx -y comfyui-mcp@latest connect`. Replaces the
  single OS-guessed command + Windows caveat, so a copy always pastes-and-runs in
  the shell you're actually using.

## [0.4.11] - 2026-07-01

### Added

- **Secure bridge for remote pods.** When a local orchestrator drives this pod via
  `connect` over https, it advertises a token-gated `wss://` bridge URL (a
  Cloudflare tunnel) to two new routes — `POST /comfyui_mcp_panel/advertise_bridge`
  and `GET /comfyui_mcp_panel/bridge_url`. On an **https** page the panel now fetches
  that URL on Connect and uses it instead of the plain `ws://127.0.0.1:9180` default
  — which browsers block from a secure origin (mixed content / Private Network
  Access). No URL to paste; works in any browser. Local/http pages are unchanged.
  Pairs with comfyui-mcp 0.23.4.

## [0.4.10] - 2026-07-01

### Changed

- **The "run the agent on YOUR machine" hint, the onboarding step, and the help
  dropdown now show `npx -y comfyui-mcp@latest connect`** — replacing the deprecated
  `--panel-orchestrator` flag, and pinned to `@latest` so users pick up new releases.
  `connect` (no URL) starts the orchestrator and auto-targets whatever ComfyUI the
  panel is served from (local or a remote pod).
- README / pyproject positioning: **"the local-first, agent-native control plane for
  ComfyUI"**.

## [0.4.9] - 2026-07-01

### Added

- **The agent now sees ComfyUI's validation errors the moment you do.** A
  `⚠️ GRAPH VALIDATION` block is injected at the agent's turn start — populated from
  `app.lastNodeErrors`, the same data behind the frontend's "N ERRORS" panel (missing
  models, `value_not_in_list` / invalid widget values, broken links) — plus the last
  runtime execution error, labeled distinctly. Previously the agent only learned of a
  broken graph if it independently re-ran. It mirrors the existing `⟳ MANUAL CANVAS
  CHANGES` injection and is **event-driven**: shown only when errors exist AND the
  state changed since the last injection (no nagging on mid-build graphs, no token
  cost on clean/chat turns). Pairs with comfyui-mcp 0.23.2 (whose `validate_workflow`
  now reports out-of-list combo values as errors, matching this block).

## [0.4.8] - 2026-07-01

### Fixed

- **Provider switcher no longer falsely says "CLI not installed."** Readiness was
  probed only by the ComfyUI-side Python (`shutil.which` + on-disk logins), which
  runs wherever ComfyUI runs — behind a remote pod that's a box with no provider
  CLIs, no logins, and no visibility into Claude's SDK (which has no CLI at all),
  so every provider read as unavailable. The panel now prefers the **orchestrator's**
  readiness (the machine that actually runs the agents), pushed as a `{type:"backends"}`
  frame on connect, and a successful "ready" ack marks the live backend ready outright.
  Pairs with comfyui-mcp 0.23.1.

### Changed

- **Connect dropdown shows `npx -y comfyui-mcp connect`** (not the old
  `--panel-orchestrator`, which read as "local only"). With browser-host targeting
  the panel hands the orchestrator whatever ComfyUI you're viewing — local or a remote
  pod — so the bare `connect` is the canonical one-command start. OS-aware (`cmd /c`
  wrapper on Windows, where a bare npx line can trip PowerShell's exec policy).

## [0.4.7] - 2026-07-01

### Added

- **Remote ComfyUI URL (drive a RunPod / remote instance).** A new
  *Settings → Comfy MCP Agent → General → Remote ComfyUI URL (advanced)* field points the
  agent at a remote ComfyUI (e.g. `https://xxxxxxxx-8188.proxy.runpod.net`) instead of
  localhost. When set, it's sent on Connect and the orchestrator spawns its MCP with
  `COMFYUI_URL` targeting the remote server (queue, models, history, uploads all go there);
  for a non-loopback URL `COMFYUI_PATH` is deliberately omitted so the agent runs in clean
  remote mode (no local-FS/remote-API split). Blank = local (unchanged default). The URL is
  validated server-side (`http`/`https` + host) and applied on the next Connect. Your live
  canvas still follows whichever ComfyUI you opened in the browser. (MCP already supported
  remote via `COMFYUI_URL`/`isRemoteMode`; this exposes it from the panel — no MCP change.)
- **External/local orchestrator mode** (Settings → General → "Use external/local
  orchestrator (advanced)"). When ON, Connect no longer asks the ComfyUI host to
  spawn an orchestrator — it connects the bridge WebSocket straight to the
  configured Bridge URL (default `ws://127.0.0.1:9180`) and treats the host
  `/comfyui_mcp_panel/connect` POST as skipped. This lets an agent running on the
  USER's machine (`npx -y comfyui-mcp connect <url>`) drive a REMOTE ComfyUI (e.g.
  a RunPod pod with no Node/agent) — no agent login on the box, no tunnel. If no
  orchestrator answers on the bridge, the panel surfaces a clear "start it locally"
  hint with the exact `npx` command. OFF by default, so the co-located autospawn
  path is byte-for-byte unchanged. The toggle persists via ComfyUI settings.

### Changed

- **Auto-target the ComfyUI you're on — no `connect <url>`.** The panel is served
  by ComfyUI, so it sends the URL it was loaded from (`window.location`) in its
  hello; the orchestrator retargets to it and picks local vs remote mode from the
  host. So `npx -y comfyui-mcp --panel-orchestrator` just works for both a local
  ComfyUI and a remote (RunPod proxy) one — the start command everywhere is now the
  bare `--panel-orchestrator`. The Remote ComfyUI URL setting stays as an advanced
  override (subpath / tunnel cases the browser origin can't express). Requires
  `comfyui-mcp` ≥ 0.23.0.
- **Single-port multi-provider.** All providers now share ONE bridge
  (`ws://127.0.0.1:9180`) instead of a port per provider (claude 9180 / codex 9181
  / gemini 9182). The panel names its chosen provider in the `hello` handshake
  (`backend` field), and one orchestrator routes each tab to the right backend.
  Switching provider re-handshakes on the same bridge (fresh session for the new
  provider — agent sessions aren't portable across providers). Requires the paired
  `comfyui-mcp` single-port orchestrator.
- **Provider switch replays the transcript.** Because a switch starts a fresh
  session on the new provider, the panel now sends the visible user+agent
  transcript as one-shot `context` on the first message after a switch, so the new
  provider picks up the conversation (internal thinking / tool history don't carry
  — they aren't portable). Capped from the end so a long chat can't blow context.
- **External/local orchestrator is now the only mode.** Since the pack can no
  longer spawn the orchestrator, Connect always dials the bridge directly (never
  the host `/connect` POST). The "Use external/local orchestrator" toggle is
  retained for back-compat but is now a no-op.
- **The pack is now a pure frontend extension — it never spawns the orchestrator.**
  Every published registry version `0.1.0`–`0.4.6` sat `NodeVersionStatusFlagged`
  on the Comfy Registry (so the registry computed no `latest_version` and
  ComfyUI-Manager could only offer the nightly channel). The cause was
  `__init__.py` calling `subprocess.Popen([… "npx", "-y", "comfyui-mcp" …])` to
  auto-start the orchestrator: the registry standards
  (https://docs.comfy.org/registry/standards) forbid a node spawning processes /
  installing-and-running packages at runtime, and the static (Bandit) scanner
  flags it (`B404`/`B603`) regardless of runtime guards. `__init__.py` no longer
  imports or calls `subprocess` (nor `psutil`, process kills, or lockfiles); it
  only serves the panel JS and exposes **read-only** status / discovery routes.
  The remote-URL helpers are kept (they shape the start command, not a spawn).

### Removed

- In-process auto-spawn / reclaim / soft-reload / hard-restart of the orchestrator.
  The orchestrator now always runs **out-of-band** — external-orchestrator mode is
  effectively the only mode. Start it once (`npx -y comfyui-mcp connect <url>` for a
  remote instance, or `--panel-orchestrator` locally) and the panel connects to the
  bridge automatically and keeps retrying until it's up. The `/connect` etc. routes
  still exist but report status and return that command instead of launching anything.

### Added

- CI **security-scan parity** step: `bandit -r . -s B101,B112,B311 -ll` mirrors the
  Comfy Registry scanner (public stand-in `christian-byrne/custom-nodes-security-scan`)
  so a would-be-flagged release fails CI before it can publish. `.comfyignore` now
  also drops dev-only `scripts/` and `.githooks/` from the published archive.

### Fixed

- **Panel remount no longer silently swaps provider or drops the conversation
  (#43).** Navigating away from the agent panel and back (a remount) used to
  re-seed the runtime backend from the durable default and reconnect on Claude —
  swapping an active Codex session and losing its thread. The last *runtime* pick
  (session-only chip switch) now wins over the durable default on remount, so the
  panel reconnects on the same provider; combined with single-port + the
  orchestrator-owned per-(tab, backend) session, the conversation **resumes**
  instead of starting fresh. (A Settings-dialog change to the default still takes
  effect — it already writes the runtime pick.)
- **Stale Bridge URL made Connect dial a dead port.** A legacy per-backend Bridge
  URL (e.g. a migrated custom port) could survive into the single-port layout and
  send the panel to a phantom port — the "connecting… then red" flash. Bridge-URL
  resolution now reads one setting (default `ws://127.0.0.1:9180`) and self-heals a
  polluted value.

## [0.4.6] - 2026-06-29

### Added

- **Graph navigation executors** (for the panel agent's new read tools):
  - `graph_outline` — a compact, dependency-ordered TEXT map of the open graph
    (topologically sorted, each node with its key widgets + `←`/`→` wiring, plus a
    groups index). Built to be read top-to-bottom by an LLM instead of dumping JSON.
  - `graph_find_nodes` — search every node on the open graph by type, title, input/
    output port, widget name, widget value, `is_output`, `is_subgraph`, or mode (or a
    free-text query across all), returning enriched matches with a `matched_on` reason.
  - `graph_subgraph_group` — wrap an existing group's nodes into one subgraph node in a
    single step (resolves the group by title/id and computes its geometric membership).
- `graph_get_state` groups now report their member `node_ids` (groups are geometric —
  they don't own nodes), so a region can be wrapped/toggled without reconstructing
  membership by hand.
- **Manual-edit awareness.** The graph the agent leaves at each turn's end is snapshotted;
  when the user sends their next message, the live graph is diffed against it and a compact
  "⟳ MANUAL CANVAS CHANGES" list (node add/remove, mode bypass/mute, widget-value, title,
  and connection changes) is prepended to the agent's input — so a hand edit between turns
  (e.g. bypassing a node) never catches the agent unaware. Visible chat text is untouched.

### Fixed

- Agent-facing error messages now name agent tools (`panel_get_graph`/`panel_search_nodes`)
  instead of the internal `graph_get_state` command.
- `graph_find_nodes` no longer throws on exotic widget values — widget stringification is
  guarded (a BigInt or circular/custom value would have failed the whole search call).
- `graph_outline` topological sort uses an index cursor instead of `Array.shift()`, keeping
  it linear (was O(n²)) on large/flat graphs.

## [0.4.5] - 2026-06-29

### Added

- **Run to node (partial execution).** `graph_run` now accepts `to_node_id`: render only
  that output node's branch (the node plus everything upstream) via ComfyUI's native
  partial execution (`app.queuePrompt(0, batch, partial_execution_targets)`), skipping
  every other output branch — fast/cheap previewing or debugging of part of a big graph.
  The target must be a root-level **output** node (SaveImage/PreviewImage/SaveVideo/…);
  non-output or subgraph-nested targets are rejected with actionable guidance instead of
  silently running the whole graph. Node summaries now tag output nodes `is_output:true`,
  and the command line shows `→ node N` when a partial run was queued. Omitting
  `to_node_id` is byte-identical to the previous full-graph run. Pairs with the MCP
  `panel_run` `to_node_id` parameter and the `debug-render` skill (comfyui-mcp ≥ 0.21.0).

### Fixed

- **Run-result display crash.** A blocked run that returns `{ error }` (the new
  run-to-node rejection) no longer throws in the activity line — `describeCommand` guarded
  the `JSON.stringify(node_errors)` path and now shows the returned guidance for `error`
  and the node-error JSON only when `node_errors` is present.

## [0.4.4] - 2026-06-27

### Added

- **Rich media metadata in agent pushes.** When a render's media is sent to the agent,
  the executed-event note (and a structured `metadata` field) now include each output's
  path (subfolder-relative), file size, pixel dimensions, asset-set grouping ("output K
  of N from this run" + sibling filenames, or "single output"), render duration, and
  completion time. Video storyboards add format + real frame count/fps when the payload
  carries them.
- **Provider onboarding.** Connect-time readiness detection per provider (CLI on PATH +
  a login on disk; macOS Keychain handled) via `/backends`. An onboarding card shows
  only when neither provider is signed in; the panel auto-switches to a ready provider
  when the saved pick isn't usable (saved preference untouched), and a not-ready
  provider row becomes a "set up" action that seeds a prompt to the working agent.
- **Code-block tools.** Rendered fenced code blocks get a Copy button + a persisted
  global line-wrap toggle (off by default); inline code gets Copy. Hover-gated, styled
  to match the panel.
- **Render-stall warning threshold setting** (General; default 180s, range 15–3600).
  Sent on connect (the orchestrator spawn default) and pushed **live** via a `set_config`
  frame, so changing it applies without a reconnect.

## [0.4.3] - 2026-06-27

### Fixed

- **Streamed replies now render when the ComfyUI tab is in the background.** The
  reply typewriter + its commit-finalize ran on `requestAnimationFrame`, which the
  browser **pauses in a hidden/background tab** — so if you switched away during an
  agent turn (common on long multi-stage pipeline runs), the reply never painted and
  the bubble sat empty with a stuck streaming cursor, looking like the agent was
  "stuck thinking / never draining the queue" even though the turn had finished. The
  commit now finalizes the reply **synchronously when the tab is hidden**, plus a
  `visibilitychange` handler flushes any pending reply on hide and resumes the
  typewriter on return. Foreground animation is unchanged.

## [0.4.2] - 2026-06-26

### Added

- **Subgraph rail I/O + expand/dissolve** — from inside a subgraph the agent can
  now wire an interior node to the boundary: `graph_expose_subgraph_output` /
  `graph_expose_subgraph_input` expose an interior node's output/input as a
  subgraph output/input (the host subgraph node gains the slot). `graph_get_state`'s
  `rails` now reports the input/output rail node ids + their slots, and
  `graph_connect` tolerates rail endpoints with a clear "enter the subgraph first"
  error at root. `graph_unpack_subgraph` **dissolves** a subgraph back into its
  parent (inlines the interior nodes, rewires external links) — the inverse of
  create-subgraph, Ctrl+Z-undoable.
- **Pasted text renders inline in sent bubbles** — a sent (or reloaded) user
  message no longer shows the raw `[Pasted text #N]` token. Each token is now
  replaced **inline with the actual pasted content**, rendered verbatim as plain
  text — exactly as if you had typed it (no chip or preview widget). The pasted
  content is persisted with the message (capped at 100,000 chars, marked
  truncated beyond that) so reloaded conversations re-render the full text. Tokens
  with no stored content fall back gracefully to their literal text. The raw
  `text` (with tokens) is unchanged — the agent, history, and edit/rollback still
  use it.
- **Expandable attachment chips** — composer attachments now show as a chip
  strip above the input (Claude-Code style) instead of only an opaque
  `[Pasted text #N]` token in the textarea. Each chip carries a kind icon +
  label (pasted text shows a dim char count; files show their name; images show
  a thumbnail). Click a text/pasted/file/workflow chip to expand an inline,
  read-only, scrollable monospace preview of the full content (one open at a
  time); click an image chip to see a larger thumbnail. A per-chip × removes the
  attachment and precisely strips its inline token (e.g. `[Pasted text #N]`)
  from the textarea. Purely additive — the send/resolve pipeline still resolves
  attachments by token-match against the textarea, unchanged.
- **Edit focus-follow** — when the agent changes a node's widget **value**, the
  canvas now smoothly darts to that node with 50% padding so you watch the change
  land. Once edits go quiet for ~5s, it animates back to a full fit so the whole
  graph is visible again. Scoped to value edits only (wiring and node placement
  don't move the view — those keep the existing gentle fit). Reuses the
  panel-aware "fit" insets and the native zoom easing. **On by default**; toggle
  via Settings → Comfy MCP Agent → General → **"Zoom to agent edits"**.

## [0.4.1] - 2026-06-26

Start the agent with a **Connect** button instead of auto-spawning it on load.
The Comfy Registry's security scanner flagged 0.4.0 because the pack launched a
subprocess (`npx … --panel-orchestrator`) at import time. Now nothing spawns
until you explicitly click Connect — the registry-safe pattern — and the panel
still auto-connects when a bridge is already running.

### Added

- **`graph_set_node_mode`** — bypass / mute / activate a node on the live canvas
  (undo-able like every other edit), so the agent can enable a bypassed path (e.g. a
  pack's Ideogram-JSON prompt builder) instead of improvising. The graph read now
  surfaces each node's mode, so bypassed/muted nodes are visible. (#30)

### Changed

- **Connect button replaces import-time auto-spawn.** `__init__.py` no longer
  starts the orchestrator when ComfyUI imports the pack. Instead it registers a
  small local API on ComfyUI's own server (`/comfyui_mcp_panel/{status,connect,
  disconnect}`), and the panel's **Connect** button starts the orchestrator on
  demand — an explicit, authenticated, local action. On load the panel only
  auto-connects if a bridge is *already* running (you started it, or another
  tab did); otherwise it waits behind the Connect button. A **Disconnect**
  button stops an orchestrator the pack started. `COMFYUI_MCP_NO_AUTOSPAWN=1`
  now makes Connect report status without spawning; `COMFYUI_MCP_BRIDGE_PORT`
  still overrides the port. Fixes the `NodeVersionStatusFlagged` 0.4.0 release.

### Fixed

- **Run outputs now name the FINAL result vs previews.** A run emits both preview
  images (`type:"temp"`, throwaway `/tmp` names) and the saved output (`type:"output"`,
  real filename); the panel now batches them into one event, orders finals first, and
  the note tells the agent which filename is the real saved result — so it stops citing
  a preview's temp name as the output. Applies to images and videos. (#31)

## [0.4.0] - 2026-06-26

The panel now drives itself: it auto-starts an autonomous background agent on
your Claude subscription, so you just open ComfyUI and type.

### Added

- **Application Settings page** under ComfyUI Settings → **"Comfy MCP Agent"**, split
  into per-backend groups so each provider owns its own defaults (#20, #21, #27, #29):
  - **General** — Default agent backend, Auto-connect on load.
  - **Claude** / **ChatGPT (Codex)** — Default model (a dropdown of the backend's
    *fetched* models), Default reasoning effort (the backend's own scale), and a
    per-backend **Bridge URL** (`9180` for Claude, `9181` for Codex).
  - **About** — ⭐ Star on GitHub. **API tokens** — secure CivitAI / HuggingFace
    buttons (stored by the orchestrator, never in ComfyUI settings).
  - The comfyui-mcp logo in the panel header.
  - **Auto-start the panel orchestrator on load.** The pack launches
    `npx -y comfyui-mcp --panel-orchestrator` when ComfyUI loads it — idempotent
    (skips if the bridge port is already owned), auto-detects this ComfyUI's
    `COMFYUI_URL`, and runs on your Claude **subscription** (no API key). The agent
    is a background Claude Agent SDK session per tab that loads comfyui-mcp's
    bundled skills (model expertise), so the only prerequisite is being signed in
    to Claude (`claude` once). Opt out with `COMFYUI_MCP_NO_AUTOSPAWN=1`; override
    the port with `COMFYUI_MCP_BRIDGE_PORT`. Requires comfyui-mcp ≥ 0.14.
  - **Lifecycle beacon.** The pack passes its PID so the orchestrator shuts down
    when ComfyUI exits — including crashes/hard-kills — with an `atexit` teardown
    on clean shutdown too. No orphan left holding the bridge port.

### Fixed

- **Reconnect storm eliminated at the root.** Only one bridge client may be live per
  page now — a re-rendered/restored sidebar no longer spawns a second client that
  shares the tab id and ping-pongs the connection (the bridge's close-old-on-new-hello
  was closing each socket in a ~1s loop). (#28)
- **Backend-switch storm.** Switching Claude↔Codex no longer re-enters the connect
  path via a settings `onChange`; a live switch produces exactly one connect. (#29)
- **Per-backend bridge ports.** The Codex backend connects to `9181` (not Claude's
  `9180`), and **Reconnect after a switch dials the right port** (the default URL is no
  longer mistaken for a manual override). (#25, #29)
- **Cold-start "stuck on connecting".** A handshake timeout now auto-redials (bounded)
  and recovers like Reconnect, instead of sitting idle while the agent spawns. (#29)
- **Settings-load reconnect storm** — ComfyUI fires `onChange` during its startup
  settings load; appliers are now gated until the panel is armed. (#22)
- **Steady connection status** — no connecting↔disconnected flicker, with
  backend-aware patience for slow Codex cold starts. (#24)

### Changed

- **Connection UI reflects the orchestrator model.** The settings help text and
  header no longer tell you to wire the MCP into your interactive session with
  `--channels` (which would steal the bridge port from the orchestrator); they
  now describe the autonomous background agent and the one-time
  `npx -y comfyui-mcp --panel-orchestrator` fallback.

## [0.3.1] - 2026-06-25

### Fixed

- **`comfy_reboot` (restart_comfyui) no longer reports a false failure.** ComfyUI
  Desktop's Manager `exit(0)`s before answering the reboot POST, so the fetch
  rejected with "Failed to fetch" and the restart looked failed (auto-resume never
  armed). A dropped connection mid-request is now treated as a successful reboot,
  with an endpoint fallback chain and accurate errors otherwise.
- **Stuck soft-reload auto-recovers.** If a soft-reload's fresh orchestrator binds
  but the agent handshake stalls, the panel now auto-escalates to a clean reconnect
  (~11s) — what you'd do by clicking Reconnect — instead of sitting on "waiting for
  the panel agent."
- **Workflow tabs**: `save` keeps a renamed tab's title (no more "Untitled …"
  overwrite); merely opening a workflow no longer marks a clean tab modified.
- **Run output images batch at run-end.** A multi-output run now delivers all its
  images to the agent in ONE turn when the run completes (buffered per `prompt_id`,
  flushed on `execution_success`, with a debounce fallback) instead of a fragmented
  turn per node — while still painting each image live as it finishes.
- **Desktop-nested ComfyUI path self-heal** in `_detect_comfyui_path` (mirrors the
  orchestrator fix).

## [0.3.0] - 2026-06-25

The polished public release — now live on the [Comfy Registry](https://registry.comfy.org/nodes/comfyui-agent-panel) and installable from ComfyUI-Manager.

### Added

- **Provider switcher in the model selector.** Pick Claude or ChatGPT from a
  PROVIDER section at the top of the model popup (Provider → Model → Effort).
- **`show_media` + `free_vram` panel commands**, **soft-reload ↔ auto-respawn
  interlock**, **pack force-reclaim** of a wedged orchestrator, **Desktop-nested
  ComfyUI path self-heal**, and **effort snaps to the nearest supported level** on a
  model/provider switch (no silent drop). New multi-provider branding (banner, icon,
  OG card).

- **Run errors interrupt the agent and show a widget.** When a queued render fails,
  the panel now names the failing node (e.g. `Ideogram4PromptBuilderKJ (node 200)`),
  pushes it to the agent as an urgent `run_error` event — the orchestrator
  **interrupts the live turn and front-queues it**, so the agent stops and fixes the
  error instead of carrying on as if the run succeeded — and immediately renders a
  red **error card** in the chat, so you see it without waiting on a check-errors
  call. (ComfyUI targets `execution_error` to the queuing client, so the panel is
  the right place to catch and forward it.)

- **Multi-provider agent: Claude + ChatGPT/Codex at full parity.** The panel is no
  longer Claude-only — a **backend picker** (Claude / ChatGPT chips) lets you choose
  a provider rather than a port, and each runs its own background orchestrator on
  *your* subscription (no API keys). Both providers reach **full feature parity**:
  - **Provider switch** posts a system message and starts a fresh chat (sessions
    aren't shared across providers), with a **per-backend composer placeholder**
    ("Ask Claude…" / "Ask ChatGPT…").
  - **Reasoning-effort + model selector** is per-provider; a chosen effort survives
    a provider switch by mapping to the nearest valid level for the target backend.
    The **provider switcher now lives inside the model selector** (Claude models vs
    ChatGPT/GPT-5 models via Codex), so picking an agent and a model is one control.
  - **Live-canvas tools** (`panel_*`) and the **headless comfyui MCP** are exposed
    identically to both backends — in-process for Claude, and over a loopback
    streamable-HTTP MCP plus `codex app-server -c mcp_servers` for ChatGPT — so the
    `panel_*` surface (incl. the destructive-confirm gating) is the same everywhere.
  - **Knowledge parity** — both backends can discover bundled skills, installer
    packs, and the connected server's official workflow templates
    (`list_skills` / `read_skill` / `list_packs` / `read_pack_workflow` /
    `list_workflow_templates`) with steering toward packs over hand-built graphs.
  - **Docs/README rebalanced multi-provider** — setup, sign-in, and usage copy now
    present Claude and ChatGPT (Codex) as equal first-class providers.
- **One-shot workflow / pack load (`panel_load_workflow`).** Drop a whole workflow
  onto the live canvas in one call — prefer `pack:<name>` to load a bundled
  installer pack's local-GPU workflow without shuttling the JSON through the chat.
  The replaced graph is captured as an undo point (double-Esc / `/revert`).
- **Local-GPU vs paid-API cost guardrail (`check_workflow_runtime`).** Bundled
  packs are local/free; for an ad-hoc or generated graph the agent classifies the
  runtime (local / api / mixed / unknown) and **asks before spending paid API
  credits** rather than silently using hosted API nodes.
- **Registry banner & SEO listing.** Added a 21:9 brand banner
  (`assets/banner.png`) so the registry/social card uses a custom image
  instead of the generic OG fallback, and rewrote the pack description to
  lead with the terms people actually search (Claude Code, MCP / Model
  Context Protocol, AI agent, live graph editing).

- **Capability-aware empty state.** The onboarding hero now reflects the
  agent's full surface — build/edit the live graph, generate images **and
  audio** (`generate_audio`, ACE Step 1.5 / Stable Audio 3), run the workflow
  and read its errors, and find models on Civitai — with clickable example
  prompts that prefill the composer. Requires comfyui-mcp ≥ 0.13.
- **Native ComfyUI design system.** The panel is restyled on the same
  PrimeVue semantic tokens (`--p-content-background`, `--p-form-field-*`,
  `--p-primary-color`, border radii, Inter) the built-in sidebar panels use —
  it tracks your ComfyUI theme automatically. Header with live status dot,
  empty-state onboarding, animated message bubbles, auto-growing composer.
- **Activity cards.** Every graph edit the agent makes renders as a human-
  readable card in the chat feed — "➕ Added KSampler (id 26)",
  "🔗 Connected 4.MODEL → 26.model", "🎚 Set steps = 30 (was 20)" — so you
  can watch Claude work.
- **Multi-tab support.** Each ComfyUI browser tab holds its own bridge
  connection, identified by a per-tab session id plus the open workflow's
  title. The agent sees every tab (`panel_status`), routes edits per tab,
  and knows which tab you typed in. Requires comfyui-mcp ≥ 0.12.
- **Markdown-lite agent bubbles** — `code` and **bold** rendering, safely.
- **"Claude is working…" indicator.** Sending a message shows an animated
  typing indicator immediately; incoming graph edits keep it alive (and bump
  it below the newest activity card), the agent's reply retires it, and a
  45-second quiet period swaps it for a hint explaining that the agent reads
  panel messages by polling its inbox. (Claude Code doesn't stream its
  internal reasoning to MCP servers — narration + activity cards + this
  indicator are the feedback surface.)
- **`graph_clear` command** — wipes every node in a single
  `beforeChange`/`afterChange` pair, so one Ctrl+Z restores the whole graph.
  Exposed as the `panel_clear` MCP tool (comfyui-mcp ≥ 0.12).
- **Full programmatic graph & app control.** New executor commands (each
  with a matching `panel_*` MCP tool): `graph_move_node`, `graph_canvas`
  (fit / center-on-node / pan / zoom), `graph_run` (queue the open workflow,
  surfacing frontend validation errors), `graph_get_errors` (last
  `execution_error` event + `lastNodeErrors`), `workflow_save` (Ctrl+S
  path) and `workflow_save_as` (duplicate to `workflows/<name>.json`).
- **Subgraph-aware reads.** Executors target the graph you're *viewing*
  (root or an opened subgraph); `graph_get_state` reports `viewing`, marks
  subgraph nodes `is_subgraph` with an inner node count (boundary slots +
  widgets only), and `graph_get_subgraph` drills inside on demand.
- **Zed-style composer.** Rounded composer card with a context-window ring
  (radial fill — wired to `agent_status` frames; data source pending host
  support), model chip, attach button (uploads straight into ComfyUI's
  `input/` folder and inserts an `@input:` mention), and voice dictation
  via the browser's speech recognition.
- **Slash commands & @ mentions.** `/new`, `/fit`, `/run`, `/errors`,
  `/help` run locally with arrow-key + Enter completion; `@` autocompletes
  the current workflow, graph nodes, subgraphs, and registered node types.
  Outgoing messages stamp the workflow + opened subgraph so the agent has
  the context without asking.
- **Chat threads.** New-chat and history buttons in the header; threads
  persist to localStorage (last 20) and replay verbatim, activity cards
  included.

## [0.2.0] - 2026-06-19

### Added

- **Rewind & rollback (#44).** A hover ✎ on any past message opens a rollback modal
  to undo **code**, **conversation**, or **both** and resend an edited message —
  graph reverts via per-turn snapshots, conversation rewinds via `forkSession`.
  **`/revert`** undoes the last turn's graph edits, and a quick **double-Esc** in
  the composer rewinds your last turn (revert graph + recall the message to edit).
- **Pending-message tray.** Messages sent while the agent is busy now wait in a
  fixed **Pending** tray above downloads (out of the chat flow), each with
  **edit / send-now / delete**. **Send-now** interrupts the current turn (steer);
  **drag the ≡ handle** to reorder how the agent flushes them. When the agent
  dequeues a message it **materializes at the bottom of the chat** — so the chat
  reads in the exact order Claude processes them.
- **Spatial layout control.** The agent can now see and arrange the canvas: reads
  include node positions/sizes and subgraph I/O rails; it can move rails, create
  and edit groups, collapse/recolor nodes, and **screenshot** the canvas to verify
  its own layout (with the "expose inputs/outputs" rule baked into a skill).
- **Attach more than images.** The composer's attach button, drag-drop, and paste
  now accept **video**, **workflows (`.json`)**, and **text files** alongside
  images. Images and video upload into ComfyUI's `input/` folder (video is
  delivered as an `input/` path the agent can wire into a Load Video node, since
  it can't be viewed inline); workflow `.json` and text files are read and inlined
  to the agent (a recognized ComfyUI graph is flagged so it can load/analyze/merge
  it). Each file drops a typed chip — `[Image #N]` / `[Video #N]` / `[Workflow #N]`
  / `[File #N]` — and the picker accepts multiple files at once.

### Fixed

- **Reconnect durability.** Connect now reclaims a lockfile-less orchestrator
  "zombie" (alive but no longer serving the bridge) that would otherwise survive
  reloads and a full ComfyUI restart and block reconnection — it finds the port
  owner, and if it's our orchestrator, kills its tree and respawns a clean one.
- **Rollback anchor stability** — the rewind anchor is stored as the turn's UUID in
  the message's own handler (not an array index), so a bounded-history eviction
  can't point a rollback at the wrong turn.
- **Save-card** rendering fix.

### Changed

- **BREAKING: MCP-driven, no API keys.** Dropped the AI-SDK `/api/chat`
  backend entirely. The panel is now a WebSocket client of
  [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s `--channels`
  bridge (`ws://127.0.0.1:9101`): **your own Claude Code session is the
  agent**, subscription-billed, zero LLM API keys anywhere in the path.
  Settings reduced to one field (bridge URL); SSE parser and bearer token
  removed.

### Fixed

- `import { app } from "/scripts/app.js"` — `window.app` is no longer
  assigned at extension-eval time on ComfyUI frontend 1.4x, so the v1
  global-read pattern silently failed and the sidebar tab never registered.

## [0.1.3] - 2026-06-19

### Added

- **Live-streaming chat** — extended-thinking in a collapsible "see thinking"
  accordion + character-by-character reply, with a live thinking-token counter.
- **SDK slash commands** in the composer `/` menu — `/compact`, `/context`,
  `/usage`, `/loop`, `/goal`, `/clear` (the SDK's useful built-ins).
- **`/restart` — one-click recovery for a wedged agent.** Kills the orchestrator
  **and its whole child tree** (clearing a dead Agent-SDK shell an in-place reload
  can't) and starts a **fresh** session — resuming would just restore the wedge.
  Pure-Python route, so it works even when the agent isn't answering.
- **Per-message delivery status** (queued → seen) with edit/cancel on a queued
  message, and a **live model-download progress** tray.
- **Subgraph authoring** — promote/retract inner widgets, node-title rename,
  workflow-tab tools, built-in Manager install→restart→resume.

### Changed

- **Rebranded to "ComfyUI Agent Panel"** (registry slug `comfyui-agent-panel`);
  license declared as the Comfy-correct `{ file = "LICENSE" }` table form.
- **Removed all `--channels` plumbing.** The panel runs only on the autonomous
  orchestrator (dedicated bridge `9180`); reload/restart live as slash commands
  (`/reload`, `/reload-ui`, `/restart`), not header buttons.

### Fixed

- **Pid-reuse-safe orchestrator kill** — identity (cmdline + creation time) is
  re-verified immediately before every terminate/kill, for the orchestrator and
  each child, so a recycled pid is never mistaken for ours and a user's unrelated
  process is never signalled.
- **Connect honors the Bridge URL field** (previously only Reconnect did).
- **Deferred extension registration** so a Vite/Rolldown early module eval can't
  throw and deadlock the loader (adapted from a community PR, thanks
  @FreesoSaiFared).
- **Truthful "connected".** The panel now turns green only after the orchestrator
  handshake (its `models` frame) arrives — a non-orchestrator squatting the
  bridge port (e.g. a stray `comfyui-mcp --channels` server from another
  Claude/Cursor/codex session) leaves it on "connecting…" with a clear warning
  instead of a silent dead connection.
- **Dedicated bridge port `9180`.** The panel/orchestrator bridge moved off
  `9101` (now reserved for the legacy `--channels` path) so a `--channels` server
  can't steal it. Saved bridge URLs on the old `9101` default auto-migrate.
- **Sticky auto-reconnect.** Once you connect, the panel reconnects on its own —
  respawning the orchestrator if it died (e.g. after a ComfyUI reboot) — on every
  open, until you explicitly **Disconnect**.
- **Drop-zone** appears only while dragging a file and is scoped to the composer
  (was permanently visible over the whole panel).
- **Registry-safe `__init__.py`.** Nothing executes at import except registering
  the Connect/disconnect/reload routes; the only subprocess the pack ever runs is
  the orchestrator spawn behind an explicit **Connect** (POST). Process
  start-time and process-kill are psutil-only — no constructed PowerShell scripts
  or `taskkill`, so the security scanner sees no shell-exec surface.

### Added

- **Drag-drop / paste images** and **paste-large-text chips**, delivered to the
  agent as inline image blocks — chips, `@input:`/`@node:` mentions, and
  end-of-run output — with no fetch round-trip.
- **Smooth animated zoom-to-fit** after the agent makes structural edits.
- **Programmatic save** (no Save/Rename dialog) and a persistent **"working"**
  indicator with cycling status words.

## [0.1.0] - 2026-06-12

### Added

- Initial release: sidebar **Agent** tab with a chat UI, six-tool graph
  executor (`get_state`, `add_node`, `remove_node`, `connect`, `disconnect`,
  `set_widget`) wrapped in `beforeChange`/`afterChange` for native Ctrl+Z
  undo, talking to the comfyui-mcp AI-SDK backend.

[0.2.0]: https://github.com/artokun/comfyui-mcp-panel/releases/tag/v0.2.0
[0.1.0]: https://github.com/artokun/comfyui-mcp-panel/commits/4f22ed0
