#!/usr/bin/env python3
"""Serve the web app for testing, like `python3 -m http.server --directory web`, plus:

- scratch-api/projects/<id> is forwarded to https://api.scratch.mit.edu/projects/<id>,
  as the reverse proxy on the real web server does (see deploy/apache-scratch2worksheet.conf),
- browsers are told not to cache anything, so a normal reload picks up changes.

    python3 tools/serve.py [--port 8080]
"""

import argparse
import functools
import http.server
import re
import urllib.error
import urllib.request
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
API_PATH = re.compile(r"^/scratch-api/projects/(\d+)/?$")
SCRATCH_API = "https://api.scratch.mit.edu/projects/"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        match = API_PATH.match(self.path.split("?", 1)[0])
        if match:
            self.proxy(SCRATCH_API + match.group(1))
        else:
            super().do_GET()

    def proxy(self, url):
        request = urllib.request.Request(url, headers={"User-Agent": "scratch-worksheets (test server)"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, body = response.status, response.read()
                content_type = response.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read()
            content_type = error.headers.get("Content-Type", "application/json")
        except OSError as error:
            self.send_error(502, f"could not reach the Scratch API: {error}")
            return
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(WEB))
    server = http.server.ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"Serving the web app at http://{args.bind}:{args.port}/ (stop with Ctrl+C)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
