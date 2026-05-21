#!/usr/bin/env python3
import http.server, socketserver, urllib.request, urllib.error, ssl, json, re, os

PORT = int(os.environ.get("PORT", 8000))
IS_LOCAL = os.getenv("RENDER") is None
FORCE_RELAY = os.getenv("FORCE_RELAY", "0") == "1"

class StreamComHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Endpoint to extract HLS stream URL from Vixcloud page
        if self.path.startswith("/get-stream?url="):
            target_url = self.path.split("url=")[1]
            self._extract_stream(target_url)
            return
        # Proxy Vixcloud embed pages when needed
        if self.path.startswith("/vixcloud/"):
            self._proxy_remote("https://vixcloud.co" + self.path[len("/vixcloud"):])
            return
        # Proxy Vixcontent pages when needed
        if self.path.startswith("/vixcontent/"):
            self._proxy_remote("https://vix-content.net" + self.path[len("/vixcontent"):])
            return
        # Serve static files (index.html, app.js, etc.)
        super().do_GET()

    def _proxy_remote(self, target_url):
        # Determines whether to fetch directly or via Render relay
        if IS_LOCAL or FORCE_RELAY:
            # Direct fetch from target (render environment has authorized IP)
            fetch_url = target_url
        else:
            # Fallback: fetch via our own server as a simple proxy (should not happen in production)
            fetch_url = target_url
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
            req = urllib.request.Request(fetch_url, headers=headers)
            with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
                content = resp.read()
                self.send_response(resp.getcode())
                for k, v in resp.getheaders():
                    # Strip security headers that would block embedding
                    if k.lower() in ("content-security-policy", "x-frame-options"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(content)
        except Exception as e:
            self.send_error(500, str(e))

    # Extract the direct HLS stream URL from a Vixcloud embed page
    def _extract_stream(self, url):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
                html = resp.read().decode('utf-8', errors='ignore')
                token_match = re.search(r"['\"]token['\"]\s*[:=]\s*['\"]([^'\"]+)['\"]", html)
                expires_match = re.search(r"['\"]expires['\"]\s*[:=]\s*['\"]([^'\"]+)['\"]", html)
                playlist_match = re.search(r"url\s*[:=]\s*['\"]([^'\"]+/playlist/\d+)[^'\"]*['\"]", html)
                if not (token_match and expires_match and playlist_match):
                    simple_match = re.search(r"(https?://[^\s\"\']+\.m3u8)", html)
                    if simple_match:
                        stream_url = simple_match.group(1)
                    else:
                        self.send_error(500, "Unable to extract stream URL from Vixcloud page")
                        return
                else:
                    token = token_match.group(1)
                    expires = expires_match.group(1)
                    pid = re.search(r"/playlist/(\d+)", playlist_match.group(1)).group(1)
                    stream_url = f"https://vixcloud.co/playlist/{pid}?token={token}&expires={expires}&b=1"
                payload = json.dumps({"stream_url": stream_url}).encode('utf-8')
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except Exception as e:
            self.send_error(500, str(e))

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), StreamComHandler) as httpd:
        httpd.serve_forever()