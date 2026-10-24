#!/usr/bin/env python3
"""Serves the built app (app/build, or the folder given) on http://localhost:8080.

Python's own `http.server` would work too, but this one does what a good
static host does: it sends the cross-origin isolation headers (so language
servers that need SharedArrayBuffer start on the first load, without the
service worker's one-time reload) and serves the precompressed `.br`/`.gz`
sibling of a file when the browser accepts it, which makes the language
packs several times smaller to download. Standard library only.

    python3 serve.py [folder] [--port 8080]
"""

import argparse
import functools
import http.server
import mimetypes
import os
import urllib.parse

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        path = urllib.parse.urlsplit(self.path).path
        if path.endswith("service-worker.js") or path.endswith(".html") or path.endswith("/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            # A folder without its slash gets SimpleHTTPRequestHandler's
            # redirect: served in place, its page would resolve relative URLs
            # against the parent folder.
            if not urllib.parse.urlsplit(self.path).path.endswith("/"):
                return super().send_head()
            path = os.path.join(path, "index.html")
        accepted = {
            part.split(";")[0].strip()
            for part in self.headers.get("Accept-Encoding", "").split(",")
            if not part.replace(" ", "").endswith(";q=0")
        }
        for encoding, suffix in (("br", ".br"), ("gzip", ".gz")):
            if encoding in accepted and os.path.isfile(path + suffix) and os.path.isfile(path):
                return self._send_compressed(path, path + suffix, encoding)
        return super().send_head()

    def _send_compressed(self, original, compressed, encoding):
        f = open(compressed, "rb")
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(original))
        self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return f


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder", nargs="?", default=os.path.join(here, "app", "build"))
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=args.folder)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving {args.folder} at http://{args.bind}:{args.port}/")
        server.serve_forever()


if __name__ == "__main__":
    main()
