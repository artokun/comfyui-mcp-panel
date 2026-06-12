"""ComfyUI MCP Panel — UI-only custom node pack.

Ships no Python nodes. Its sole job is to serve the sidebar panel JS
(``web/js/comfyui-mcp-panel.js``) to the ComfyUI frontend via
``WEB_DIRECTORY``. The panel talks to the agent backend that ships in the
``comfyui-mcp`` npm package (run with ``COMFYUI_MCP_AGENT_POC=1``).
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Serve the bundled JS extension(s) from ./web to the ComfyUI frontend.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
