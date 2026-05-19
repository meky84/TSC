#!/usr/bin/env python3
"""
Server locale di sviluppo per StreamCom.
Avvia un server HTTP che:
  1. Serve i file locali (index.html, style.css, app.js)
  2. Fa da proxy trasparente verso streamingcommunityz.associates
     su /proxy/... aggirando il blocco CORS del browser.
Uso: python server.py
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import ssl
import sys
import os
import json

PORT = int(os.environ.get("PORT", 8000))
CONFIG_FILE = "config.json"
DEFAULT_BASE_SITE = "https://streamingcommunityz.associates"

def load_config():
    base_site = DEFAULT_BASE_SITE
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                config = json.load(f)
                if "base_site" in config:
                    base_site = config["base_site"].rstrip("/")
        except Exception as e:
            print(f"Errore nel caricamento di {CONFIG_FILE}: {e}. Uso il default.")
            
    if "://cdn." not in base_site:
        cdn_site = base_site.replace("://", "://cdn.")
    else:
        cdn_site = base_site
        
    return base_site, cdn_site

BASE_SITE, CDN_SITE = load_config()


class StreamComHandler(http.server.SimpleHTTPRequestHandler):
    """Gestisce sia i file locali che le richieste proxy verso il sito."""

    def log_message(self, format, *args):
        # Log all messages (including errors) to console
        super().log_message(format, *args)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        # --- Proxy verso il sito principale ---
        if self.path.startswith("/proxy/"):
            target_path = self.path[len("/proxy"):]   # /it/archive, /it/search?q=..., ecc.
            self._proxy_request(BASE_SITE + target_path)

        # --- Proxy verso il CDN (immagini) ---
        elif self.path.startswith("/cdn/"):
            target_path = self.path[len("/cdn"):]
            self._proxy_request(CDN_SITE + target_path)

        # --- Proxy verso Vixcloud ---
        elif self.path.startswith("/vixcloud/"):
            target_path = self.path[len("/vixcloud"):]
            self._proxy_request("https://vixcloud.co" + target_path)

        # --- File locali con fallback proxy ---
        else:
            clean_path = self.path.split("?")[0].lstrip("/")
            local_path = os.path.join(os.getcwd(), clean_path) if clean_path else os.path.join(os.getcwd(), "index.html")
            
            if os.path.exists(local_path) and os.path.isfile(local_path):
                super().do_GET()
            else:
                # Controlla Referer per instradare le richieste di asset relativi al host giusto
                referer = self.headers.get("Referer", "")
                if "/vixcloud/" in referer or "vixcloud.co" in referer:
                    self._proxy_request("https://vixcloud.co" + self.path)
                else:
                    self._proxy_request(BASE_SITE + self.path)

    def _proxy_request(self, url):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode   = ssl.CERT_NONE

        req = urllib.request.Request(url, headers={
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/124.0.0.0 Safari/537.36",
            "Accept":          "*/*",
            "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        })

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
                body         = resp.read()
                content_type = resp.headers.get("Content-Type", "")

                # Se la risorsa contiene testo/script/playlist, riscrivi i domini Vixcloud per forzare il same-origin
                if any(t in content_type for t in ["text/html", "javascript", "mpegurl", "mpegURL", "json", "xml"]):
                    try:
                        text = body.decode("utf-8", errors="ignore")
                        host = self.headers.get("Host", f"localhost:{PORT}")
                        proto = self.headers.get("X-Forwarded-Proto", "http" if "localhost" in host or "127.0.0.1" in host else "https")
                        proxy_base = f"{proto}://{host}"
                        text = text.replace("https://vixcloud.co", f"{proxy_base}/vixcloud")
                        text = text.replace(r"https:\/\/vixcloud.co", fr"{proxy_base}\/vixcloud")
                        body = text.encode("utf-8")
                    except Exception as e:
                        pass

                self.send_response(200)
                self.send_header("Content-Type",   content_type)
                self.send_header("Content-Length", str(len(body)))
                self._cors_headers()
                self.end_headers()
                self.wfile.write(body)

        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e))
        except urllib.error.URLError as e:
            self.send_error(502, f"Proxy error: {e.reason}")
        except Exception as e:
            self.send_error(500, str(e))


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), StreamComHandler) as httpd:
        print("=" * 55)
        print("  StreamCom – Server locale avviato")
        print("=" * 55)
        print(f"  Apri nel browser:  http://localhost:{PORT}")
        print(f"  Proxy sito:        http://localhost:{PORT}/proxy/it/archive")
        print(f"  Proxy CDN:         http://localhost:{PORT}/cdn/...")
        print("  Premi Ctrl+C per fermare.")
        print("=" * 55)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer fermato.")
            sys.exit(0)


if __name__ == "__main__":
    main()
