"""Stand up py/rendezvous.py on its own aiohttp app.

Exercises the EXACT module the pack registers, without touching the shared ComfyUI
install. The ComfyUI-hosted path is proven separately in a browser (same-origin is
the whole claim of hypothesis A, and only a real browser can prove that).
"""
import importlib.util
import sys

from aiohttp import web

PATH = sys.argv[1]
PORT = int(sys.argv[2])

spec = importlib.util.spec_from_file_location("rendezvous", PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Shorten the TTL so the expiry test does not need a five-minute wall clock.
if len(sys.argv) > 3:
    mod.CODE_TTL_SECONDS = int(sys.argv[3])

routes = web.RouteTableDef()
mod.register(routes, web)
app = web.Application()
app.add_routes(routes)
print("rdv harness on http://127.0.0.1:{} (CODE_TTL={}s)".format(PORT, mod.CODE_TTL_SECONDS), flush=True)
web.run_app(app, host="127.0.0.1", port=PORT, print=None)
