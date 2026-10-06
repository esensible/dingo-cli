#!/usr/bin/env python3
"""Dev server for the web app: static files, no caching, correct wasm MIME.

Run inside the dev container (never on the host):
    python3 web/serve.py            # serves web/ on 0.0.0.0:5173
The container publishes 5173 to the host's 127.0.0.1, and Web Bluetooth
treats http://localhost:5173 as a secure context. Keep the port: Chrome's
remembered Bluetooth permission is tied to the origin.
"""
import http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript", ".md": "text/markdown; charset=utf-8"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
