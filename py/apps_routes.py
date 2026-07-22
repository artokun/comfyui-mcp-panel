"""Micro-Apps ("Apps") — local app bundle storage + headless run engine.

An "app" is a workflow packaged for one-click runs without a canvas: a
directory under ComfyUI's user dir (NOT the workflows dir, so hidden apps
never surface in the workflow browser):

    <user>/comfyui-mcp-panel/apps/<app-id>/
      manifest.json   # name/description/appMode{inputs,outputs}/deps/flags
      workflow.json   # litegraph UI format — ABSENT when hideWorkflow=true
      prompt.json     # API-format snapshot (patched per run)
      thumbnail.png   # optional

Routes (same register() pattern as py/training_routes.py):

- GET    /comfyui_mcp_panel/apps                      list manifests
- POST   /comfyui_mcp_panel/apps                      create bundle
- GET    /comfyui_mcp_panel/apps/{id}                 manifest + bundle facts
- PUT    /comfyui_mcp_panel/apps/{id}                 update manifest / files
- DELETE /comfyui_mcp_panel/apps/{id}                 remove bundle
- GET    /comfyui_mcp_panel/apps/{id}/thumbnail       serve thumbnail.png
- POST   /comfyui_mcp_panel/apps/{id}/run             patch + queue, returns prompt_id
- GET    /comfyui_mcp_panel/apps/{id}/runs/{prompt_id}  run status + outputs

The run/status routes are server-side (not browser fetches) so the exact same
surface backs the mobile app's whitelisted `apps_*` bridge tools — ONE storage
and execution implementation for panel and mobile.

hideWorkflow is BEST-EFFORT obfuscation, never security: the prompt is still
visible to anyone running the app via ComfyUI's /history, and auto-installed
models/custom nodes reveal the graph's dependencies. UI copy must say so.
"""

import asyncio
import json
import logging
import os
import re
import uuid as uuid_module
from os import environ  # bare-name on purpose — see root __init__.py (Registry scanner)

logger = logging.getLogger(__name__)

# Caps: prompt.json can legitimately hold embedded images (base64) so it's
# roomier than a pure-graph file; thumbnails are served back to browsers.
_MAX_JSON_BYTES = 16 * 1024 * 1024
_MAX_THUMB_BYTES = 5 * 1024 * 1024
_MAX_NAME = 120
_MAX_DESC = 4000

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Run-patch keys look like "6.text" (nodeId.widget); nodeIds in API prompts are
# decimal strings, widget names are identifier-ish (LoRA stacks use dots too —
# split on the FIRST dot only, so "lora_1.model" stays intact as the widget).
_PATCH_KEY_RE = re.compile(r"^(\d+)\.(.+)$", re.S)


def _apps_root() -> str:
    """Root holding every app bundle. Env override for tests; default under
    ComfyUI's own user dir so it survives portable installs and stays out of
    the workflows dir entirely."""
    override = environ.get("COMFYUI_MCP_APPS_DIR", "").strip()
    if override:
        return os.path.realpath(override)
    import folder_paths  # ComfyUI's own path registry (host-provided)

    return os.path.realpath(os.path.join(folder_paths.get_user_directory(), "comfyui-mcp-panel", "apps"))


def _bundle_dir(root: str, app_id: str) -> str:
    """Validated, contained bundle path for ``app_id`` — 400-class callers
    reject anything that isn't a plain uuid, so this can never traverse."""
    if not _UUID_RE.match(app_id or ""):
        raise ValueError("app id must be a uuid")
    path = os.path.realpath(os.path.join(root, app_id.lower()))
    if path != root and not path.startswith(root + os.sep):
        raise ValueError("app id escapes the apps root")
    return path


def _atomic_write(path: str, data: bytes) -> None:
    """tmp-then-rename so a crash mid-write can't leave a torn bundle file."""
    tmp = path + ".tmp-" + uuid_module.uuid4().hex[:8]
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _read_manifest(bdir: str) -> dict:
    with open(os.path.join(bdir, "manifest.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def _bundle_facts(bdir: str) -> dict:
    return {
        "has_workflow": os.path.isfile(os.path.join(bdir, "workflow.json")),
        "has_prompt": os.path.isfile(os.path.join(bdir, "prompt.json")),
        "has_thumbnail": os.path.isfile(os.path.join(bdir, "thumbnail.png")),
    }


def _sanitize_manifest(raw, *, for_update: bool = False) -> dict:
    """Whitelist-shape the client-supplied manifest. Unknown keys are dropped
    (forward-compat: clients may send P5 pricing fields; we keep pricing_json /
    hosted_only pass-through so the schema is forward-compatible)."""
    if not isinstance(raw, dict):
        raise ValueError("manifest must be an object")
    out = {}
    if not for_update or "id" in raw:
        app_id = str(raw.get("id") or "")
        if not _UUID_RE.match(app_id):
            raise ValueError("manifest.id must be a uuid")
        out["id"] = app_id.lower()
    if not for_update or "name" in raw:
        name = str(raw.get("name") or "").strip()
        if not name:
            raise ValueError("manifest.name is required")
        out["name"] = name[:_MAX_NAME]
    out["description"] = str(raw.get("description") or "")[:_MAX_DESC]

    app_mode = raw.get("appMode")
    if app_mode is None and not for_update:
        app_mode = {}
    if app_mode is not None:
        if not isinstance(app_mode, dict):
            raise ValueError("manifest.appMode must be an object")
        inputs = []
        for item in app_mode.get("inputs") or []:
            if not isinstance(item, dict):
                continue
            try:
                node_id = int(item.get("nodeId"))
            except (TypeError, ValueError):
                continue
            widget = str(item.get("widget") or "").strip()
            if not widget:
                continue
            entry = {
                "nodeId": node_id,
                "widget": widget,
                "label": str(item.get("label") or widget)[:_MAX_NAME],
                "kind": str(item.get("kind") or "text"),
            }
            # Form-rendering extras: combo choices + the value at conversion
            # time (becomes the form's default). Scalars/lists only — anything
            # else would bloat or complicate the manifest.
            if isinstance(item.get("choices"), list):
                entry["choices"] = [str(c) for c in item["choices"]][:200]
            if "default" in item and isinstance(item["default"], (str, int, float, bool)):
                entry["default"] = item["default"]
            inputs.append(entry)
        outputs = []
        for item in app_mode.get("outputs") or []:
            if not isinstance(item, dict):
                continue
            try:
                node_id = int(item.get("nodeId"))
            except (TypeError, ValueError):
                continue
            outputs.append({"nodeId": node_id, "kind": str(item.get("kind") or "images")})
        out["appMode"] = {
            "inputs": inputs,
            "outputs": outputs,
            "importedFromFrontend": bool(app_mode.get("importedFromFrontend")),
        }

    for key, default in (("hideWorkflow", False),):
        if not for_update or key in raw:
            out[key] = bool(raw.get(key, default))
    for key in ("source", "deps", "published", "pricing_json", "hosted_only"):
        if key in raw:
            out[key] = raw[key]
        elif not for_update:
            out[key] = None if key in ("published", "pricing_json") else (
                {} if key in ("source", "deps") else False
            )
    return out


def _validate_prompt_json(raw) -> dict:
    if not isinstance(raw, dict) or not raw:
        raise ValueError("prompt must be a non-empty object (API format)")
    for node_id, node in raw.items():
        if not str(node_id).isdigit():
            raise ValueError("prompt keys must be numeric node ids")
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise ValueError("prompt nodes must be {class_type, inputs} objects")
        if not node.get("class_type"):
            raise ValueError("prompt node missing class_type")
    return raw


def _apply_patch(prompt: dict, values: dict) -> dict:
    """Return a copy of ``prompt`` with input widget values replaced. Strict:
    every patch key must address an existing node AND input — a miss means the
    manifest drifted from the snapshot and failing loudly beats silently
    running with stale values."""
    patched = json.loads(json.dumps(prompt))
    for key, value in values.items():
        m = _PATCH_KEY_RE.match(str(key))
        if not m:
            raise ValueError("bad patch key (want '<nodeId>.<widget>'): {!r}".format(key))
        node_id, widget = m.group(1), m.group(2)
        node = patched.get(node_id)
        if node is None:
            raise ValueError("patch targets unknown node {}".format(node_id))
        if widget not in node["inputs"]:
            raise ValueError("patch targets unknown input {!r} on node {}".format(widget, node_id))
        node["inputs"][widget] = value
    return patched


def _self_base_url() -> str:
    """Loopback base URL for self-calls (/prompt, /history). ComfyUI's
    PromptServer knows its own address/port; prefer 127.0.0.1 for wildcard
    binds. No TLS handling — a TLS-fronted ComfyUI still serves plain HTTP on
    its own socket."""
    from server import PromptServer  # type: ignore

    inst = PromptServer.instance
    addr = getattr(inst, "address", "127.0.0.1") or "127.0.0.1"
    if addr in ("0.0.0.0", "::"):
        addr = "127.0.0.1"
    port = getattr(inst, "port", 8188)
    return "http://{}:{}".format(addr, port)


async def _self_post_json(session, path: str, payload: dict):
    async with session.post(_self_base_url() + path, json=payload) as resp:
        body = await resp.json(content_type=None)
        return resp.status, body


async def _self_get_json(session, path: str):
    async with session.get(_self_base_url() + path) as resp:
        body = await resp.json(content_type=None)
        return resp.status, body


def register(routes, web):
    """Register the Apps routes on ``PromptServer.instance.routes``."""

    @routes.get("/comfyui_mcp_panel/apps")
    async def _list_apps(_request):
        def _scan():
            root = _apps_root()
            if not os.path.isdir(root):
                return []
            out = []
            for entry in sorted(os.listdir(root)):
                bdir = os.path.join(root, entry)
                if not os.path.isdir(bdir):
                    continue
                try:
                    manifest = _read_manifest(bdir)
                except Exception:
                    continue  # torn/foreign dir — never break the listing
                out.append({**manifest, **_bundle_facts(bdir)})
            return out

        apps = await asyncio.to_thread(_scan)
        return web.json_response({"apps": apps})

    @routes.post("/comfyui_mcp_panel/apps")
    async def _create_app(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        try:
            manifest = _sanitize_manifest(body.get("manifest"))
            prompt = _validate_prompt_json(body.get("prompt"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        workflow = body.get("workflow")
        hide = manifest.get("hideWorkflow", False)
        if not hide:
            if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
                return web.json_response(
                    {"error": "workflow (UI format with a nodes array) is required unless hideWorkflow"},
                    status=400,
                )
        thumb_b64 = body.get("thumbnail_b64")

        def _write():
            root = _apps_root()
            bdir = _bundle_dir(root, manifest["id"])
            if os.path.exists(bdir):
                raise FileExistsError(manifest["id"])
            os.makedirs(bdir)
            import datetime

            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            manifest.setdefault("version", 1)
            manifest["createdAt"] = now
            manifest["updatedAt"] = now
            _atomic_write(
                os.path.join(bdir, "manifest.json"),
                json.dumps(manifest, indent=1).encode("utf-8"),
            )
            _atomic_write(
                os.path.join(bdir, "prompt.json"),
                json.dumps(prompt).encode("utf-8"),
            )
            if not hide:
                _atomic_write(
                    os.path.join(bdir, "workflow.json"),
                    json.dumps(workflow).encode("utf-8"),
                )
            if isinstance(thumb_b64, str) and thumb_b64:
                import base64

                raw = base64.b64decode(thumb_b64, validate=True)
                if len(raw) > _MAX_THUMB_BYTES:
                    raise ValueError("thumbnail too large")
                _atomic_write(os.path.join(bdir, "thumbnail.png"), raw)

        try:
            await asyncio.to_thread(_write)
        except FileExistsError:
            return web.json_response({"error": "app id already exists"}, status=409)
        except (ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"ok": True, "id": manifest["id"]})

    @routes.get("/comfyui_mcp_panel/apps/{id}")
    async def _get_app(request):
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        def _read():
            if not os.path.isdir(bdir):
                return None
            manifest = _read_manifest(bdir)
            return {**manifest, **_bundle_facts(bdir)}

        try:
            data = await asyncio.to_thread(_read)
        except Exception as exc:
            return web.json_response({"error": "unreadable bundle: {}".format(exc)}, status=500)
        if data is None:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(data)

    @routes.get("/comfyui_mcp_panel/apps/{id}/bundle")
    async def _get_bundle(request):
        """The full bundle for publish/import round-trips: manifest + prompt +
        workflow (when not hidden) + thumbnail as base64."""
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        def _read_bundle():
            if not os.path.isdir(bdir):
                return None
            out = {"manifest": _read_manifest(bdir)}
            for name in ("prompt", "workflow"):
                path = os.path.join(bdir, "{}.json".format(name))
                if os.path.isfile(path):
                    with open(path, "r", encoding="utf-8") as fh:
                        out[name] = json.load(fh)
            thumb = os.path.join(bdir, "thumbnail.png")
            if os.path.isfile(thumb):
                import base64

                with open(thumb, "rb") as fh:
                    out["thumbnail_b64"] = base64.b64encode(fh.read()).decode("ascii")
            return out

        try:
            data = await asyncio.to_thread(_read_bundle)
        except Exception as exc:
            return web.json_response({"error": "unreadable bundle: {}".format(exc)}, status=500)
        if data is None:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(data)

    @routes.put("/comfyui_mcp_panel/apps/{id}")
    async def _update_app(request):
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        try:
            patch = _sanitize_manifest(body.get("manifest") or {}, for_update=True)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        def _apply():
            if not os.path.isdir(bdir):
                return None
            manifest = _read_manifest(bdir)
            manifest.update(patch)
            manifest["id"] = os.path.basename(bdir)  # id is immutable
            import datetime

            manifest["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            wf_path = os.path.join(bdir, "workflow.json")
            if manifest.get("hideWorkflow") and os.path.isfile(wf_path):
                # Best-effort hide: drop the UI graph from disk entirely.
                os.remove(wf_path)
            if not manifest.get("hideWorkflow") and isinstance(body.get("workflow"), dict):
                _atomic_write(wf_path, json.dumps(body["workflow"]).encode("utf-8"))
            if isinstance(body.get("prompt"), dict):
                _validate_prompt_json(body["prompt"])
                _atomic_write(
                    os.path.join(bdir, "prompt.json"),
                    json.dumps(body["prompt"]).encode("utf-8"),
                )
            thumb_b64 = body.get("thumbnail_b64")
            if isinstance(thumb_b64, str) and thumb_b64:
                import base64

                raw = base64.b64decode(thumb_b64, validate=True)
                if len(raw) > _MAX_THUMB_BYTES:
                    raise ValueError("thumbnail too large")
                _atomic_write(os.path.join(bdir, "thumbnail.png"), raw)
            _atomic_write(
                os.path.join(bdir, "manifest.json"),
                json.dumps(manifest, indent=1).encode("utf-8"),
            )
            return {**manifest, **_bundle_facts(bdir)}

        try:
            data = await asyncio.to_thread(_apply)
        except (ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        if data is None:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(data)

    @routes.delete("/comfyui_mcp_panel/apps/{id}")
    async def _delete_app(request):
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        def _remove():
            if not os.path.isdir(bdir):
                return False
            import shutil

            shutil.rmtree(bdir)
            return True

        removed = await asyncio.to_thread(_remove)
        if not removed:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response({"ok": True})

    @routes.get("/comfyui_mcp_panel/apps/{id}/thumbnail")
    async def _get_thumbnail(request):
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        path = os.path.join(bdir, "thumbnail.png")
        if not os.path.isfile(path):
            return web.json_response({"error": "not found"}, status=404)
        return web.FileResponse(path)

    @routes.post("/comfyui_mcp_panel/apps/{id}/run")
    async def _run_app(request):
        try:
            bdir = _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        values = body.get("values") or {}
        if not isinstance(values, dict):
            return web.json_response({"error": "values must be an object"}, status=400)

        def _load_prompt():
            path = os.path.join(bdir, "prompt.json")
            if not os.path.isfile(path):
                return None
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)

        prompt = await asyncio.to_thread(_load_prompt)
        if prompt is None:
            return web.json_response({"error": "app has no prompt snapshot"}, status=404)
        try:
            patched = _apply_patch(prompt, values)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        # Dry run: return the patched prompt without queueing. The RunPod path
        # uses this — the patched prompt goes to the pod through the
        # orchestrator's enqueue_workflow instead of the local /prompt.
        if body.get("dry") is True:
            return web.json_response({"ok": True, "prompt": patched})

        import aiohttp

        async with aiohttp.ClientSession() as session:
            status, resp = await _self_post_json(session, "/prompt", {"prompt": patched})
        if status != 200:
            # Surface ComfyUI's own validation error verbatim (node_errors etc.)
            return web.json_response(
                {"error": "ComfyUI rejected the prompt", "detail": resp}, status=502
            )
        return web.json_response({"ok": True, "prompt_id": resp.get("prompt_id"), "number": resp.get("number")})

    @routes.get("/comfyui_mcp_panel/apps/{id}/runs/{prompt_id}")
    async def _run_status(request):
        try:
            _bundle_dir(_apps_root(), request.match_info["id"])
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        prompt_id = request.match_info["prompt_id"]
        if not re.match(r"^[0-9a-zA-Z-]+$", prompt_id or ""):
            return web.json_response({"error": "bad prompt id"}, status=400)

        import aiohttp

        async with aiohttp.ClientSession() as session:
            _q_status, queue = await _self_get_json(session, "/queue")
            h_status, history = await _self_get_json(session, "/history/{}".format(prompt_id))

        running = any(
            item[1] == prompt_id for item in (queue.get("queue_running") or []) if isinstance(item, list) and len(item) > 1
        )
        pending = any(
            item[1] == prompt_id for item in (queue.get("queue_pending") or []) if isinstance(item, list) and len(item) > 1
        )
        entry = None
        if h_status == 200 and isinstance(history, dict):
            entry = history.get(prompt_id)
        status_str = (
            "done" if entry is not None else ("running" if running else ("pending" if pending else "unknown"))
        )
        outputs = {}
        if entry is not None:
            outputs = entry.get("outputs") or {}
        return web.json_response(
            {
                "prompt_id": prompt_id,
                "status": status_str,
                "outputs": outputs,
                "status_detail": (entry or {}).get("status") or {},
            }
        )
