#!/usr/bin/env python3
import http.server, socketserver, urllib.request, urllib.error, ssl, sys, os, json, re

PORT = int(os.environ.get("PORT", 8000))
BASE_SITE = "https://streamingcommunityz.associates"
RENDER_URL = "https://tsc84.onrender.com"
IS_LOCAL = "RENDER" not in os.environ

class StreamComHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Instrada tutte le richieste esterne verso il proxy
        if self.path.startswith("/proxy/") or self.path.startswith("/vixcloud/") or self.path.startswith("/vixcontent/"):
            # Determina la URL reale
            target = ""
            if self.path.startswith("/proxy/"): target = BASE_SITE + self.path[7:]
            elif self.path.startswith("/vixcloud/"): target = "https://vixcloud.co" + self.path[10:]
            elif self.path.startswith("/vixcontent/"):
                parts = self.path[12:].split("/", 1)
                target = f"https://{parts[0]}.vix-content.net/{parts[1] if len(parts)>1 else ''}"
            
            self._proxy_request(target)
        else:
            super().do_GET()

    def _proxy_request(self, url):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (SmartTV; Tizen) AppleWebKit/537.36"})
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                body = resp.read()
                
                # Riscrittura aggressiva per forzare il passaggio tutto attraverso questo server
                if "text/html" in resp.headers.get("Content-Type", ""):
                    text = body.decode("utf-8", errors="ignore")
                    proxy_host = self.headers.get('Host')
                    # Forza ogni link esterno a tornare su /proxy/ o /vixcloud/
                    text = re.sub(r'https?://(vixcloud\.co|streamingcommunityz\.associates)', f'http://{proxy_host}/proxy', text)
                    body = text.encode("utf-8")

                self.send_response(resp.status)
                for h, v in resp.getheaders():
                    if h.lower() in ['content-security-policy', 'x-frame-options', 'frame-options']: continue
                    self.send_header(h, v)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
        except Exception as e:
            self.send_error(502, str(e))

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), StreamComHandler) as httpd:
        httpd.serve_forever()