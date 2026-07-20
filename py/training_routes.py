"""ComfyUI-origin helpers for the panel's LoRA-training wizard.

Two routes, same register() pattern as py/civitai_proxy.py:

- POST /comfyui_mcp_panel/training/resolve-paths
    The wizard picks images by ComfyUI reference ({filename, subfolder, type})
    but the trainer's train_prepare_dataset MCP tool needs absolute host paths.
    This resolves refs against ComfyUI's folder_paths roots (output/input/temp),
    containment- and existence-checked.

- GET /comfyui_mcp_panel/training/file?path=...
    train_status reports sample images as ABSOLUTE paths under the training
    root (~/.comfyui-mcp/training/) — unreadable by the browser. This serves
    them back over the ComfyUI origin, restricted to that root.

- GET /comfyui_mcp_panel/training/list-outputs?limit=..&pattern=..
    Structured (JSON) recent-output listing for the wizard's image picker — the
    MCP list_output_images tool returns markdown for LLMs; the grid needs data.
"""

import asyncio
import logging
import os
import pathlib
from os import environ  # bare-name on purpose — see root __init__.py (Registry scanner)

logger = logging.getLogger(__name__)

# Formats the trainer accepts (mirrors train_prepare_dataset's IMAGE_EXTS) —
# drives the output picker so every selectable image can actually be staged.
_PICK_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# Anything the /file route may serve (training samples, previews).
_SERVE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

_TYPE_DIRS = {
    "output": "get_output_directory",
    "input": "get_input_directory",
    "temp": "get_temp_directory",
}


def _training_roots() -> list:
    """Roots the /file route may serve from: the env override when set, plus the
    default. Both processes (ComfyUI + orchestrator) normally share the default;
    when the orchestrator is launched with an override ComfyUI doesn't have,
    sample paths land outside every root here and we 403 — which is correct:
    two processes with different training roots can't share a job registry
    anyway (codex finding; fail closed, never widen containment client-side)."""
    roots = []
    override = environ.get("COMFYUI_MCP_TRAINING_DIR", "").strip()
    if override:
        roots.append(override)
    base = environ.get("COMFYUI_MCP_DATA_DIR", "").strip() or os.path.join(
        pathlib.Path.home(), ".comfyui-mcp"
    )
    roots.append(os.path.join(base, "training"))
    return roots


def _newest_outputs(root: str, pattern: str, limit: int) -> list:
    """The `limit` newest image files under `root` (sync; runs in a worker
    thread). A size-bounded heap avoids materializing the whole tree."""
    import heapq

    heap = []  # min-heap by mtime, max size `limit`
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if os.path.splitext(name)[1].lower() not in _PICK_EXTS:
                continue
            if pattern and pattern not in name.lower():
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            sub = os.path.relpath(dirpath, root)
            item = {
                "filename": name,
                "subfolder": "" if sub == "." else sub.replace(os.sep, "/"),
                "type": "output",
                "size": st.st_size,
                "mtime": st.st_mtime,
            }
            if len(heap) < limit:
                heapq.heappush(heap, (st.st_mtime, id(item), item))
            elif st.st_mtime > heap[0][0]:
                heapq.heapreplace(heap, (st.st_mtime, id(item), item))
    return [item for _mtime, _i, item in sorted(heap, key=lambda x: -x[0])]


def register(routes, web):
    """Register the training-wizard routes on ``PromptServer.instance.routes``."""

    @routes.post("/comfyui_mcp_panel/training/resolve-paths")
    async def _resolve_paths(request):
        try:
            spec = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        images = spec.get("images")
        if not isinstance(images, list) or not images:
            return web.json_response({"error": "images must be a non-empty list"}, status=400)

        import folder_paths  # ComfyUI's own path registry (host-provided)

        out = []
        for item in images:
            if not isinstance(item, dict):
                out.append({"error": "not an object"})
                continue
            filename = str(item.get("filename") or "").strip()
            subfolder = str(item.get("subfolder") or "").strip()
            typ = str(item.get("type") or "output").strip()
            getter = _TYPE_DIRS.get(typ)
            if not filename:
                out.append({"error": "filename required"})
                continue
            if getter is None:
                out.append({"error": f"type must be one of {sorted(_TYPE_DIRS)}"})
                continue
            root = os.path.realpath(getattr(folder_paths, getter)())
            rel = os.path.join(subfolder, filename) if subfolder else filename
            path = os.path.realpath(os.path.join(root, rel))
            # Containment: the resolved file must stay inside its root.
            if path != root and not path.startswith(root + os.sep):
                out.append({"error": f"escapes {typ} directory: {rel}"})
                continue
            if not os.path.isfile(path):
                out.append({"error": f"not found: {rel}"})
                continue
            out.append({"path": path, "filename": filename, "subfolder": subfolder or None, "type": typ})
        return web.json_response({"paths": out})

    @routes.get("/comfyui_mcp_panel/training/file")
    async def _training_file(request):
        raw = (request.query.get("path") or "").strip()
        if not raw:
            return web.json_response({"error": "path required"}, status=400)
        path = os.path.realpath(raw)
        roots = [os.path.realpath(r) for r in _training_roots()]
        if not any(path == root or path.startswith(root + os.sep) for root in roots):
            return web.json_response({"error": "path is outside the training root"}, status=403)
        if os.path.splitext(path)[1].lower() not in _SERVE_EXTS:
            return web.json_response({"error": "not an image file"}, status=400)
        if not os.path.isfile(path):
            return web.json_response({"error": "not found"}, status=404)
        return web.FileResponse(path)

    @routes.get("/comfyui_mcp_panel/training/list-outputs")
    async def _list_outputs(request):
        try:
            limit = int(request.query.get("limit", "60"))
        except ValueError:
            limit = 60
        limit = max(1, min(limit, 200))
        pattern = (request.query.get("pattern") or "").strip().lower()

        import folder_paths  # ComfyUI's own path registry (host-provided)

        root = folder_paths.get_output_directory()
        # Off the event loop (a large output dir or slow/network storage would
        # otherwise block ComfyUI's HTTP/WS handling), and bounded: keep only
        # the `limit` newest entries instead of collecting-then-sorting the
        # whole tree (codex finding).
        images = await asyncio.to_thread(_newest_outputs, root, pattern, limit)
        return web.json_response({"images": images})
