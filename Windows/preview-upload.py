# Receives videos from Windows/preview.sh on the preview machine and saves them in the Videos folder.
# Started by .github/workflows/windows-preview.yml behind its own Cloudflare tunnel; every upload must carry PREVIEW_PASSWORD.
import hmac
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PASSWORD = os.environ["PREVIEW_PASSWORD"].encode()
FOLDER = os.path.join(os.environ["USERPROFILE"], "Videos")


class Upload(BaseHTTPRequestHandler):
    def do_PUT(self):
        if not hmac.compare_digest(self.headers.get("X-Prism-Password", "").encode(), PASSWORD):
            return self.answer(403, "Wrong password.")
        # Only a plain file name: no folders, so nothing can land outside Videos.
        name = os.path.basename(unquote(self.path).replace("\\", "/"))
        if not name or name.startswith("."):
            return self.answer(400, "Name the file in the URL.")
        length = int(self.headers.get("Content-Length", "0"))
        os.makedirs(FOLDER, exist_ok=True)
        target = os.path.join(FOLDER, name)
        partial = target + ".part"
        with open(partial, "wb") as file:
            while length > 0:
                chunk = self.rfile.read(min(length, 1 << 20))
                if not chunk:
                    break
                file.write(chunk)
                length -= len(chunk)
        if length > 0:
            os.remove(partial)
            return self.answer(400, "The upload stopped early.")
        os.replace(partial, target)
        self.answer(201, target)

    def do_GET(self):
        self.answer(200, "ready")

    def answer(self, status, text):
        body = (text + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("127.0.0.1", 8090), Upload).serve_forever()
