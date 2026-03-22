"""
Local backend proxy for Azure VM SKU Explorer.
Handles Azure auth + API calls server-side to avoid browser CORS restrictions.
"""
import json
import urllib.request
import urllib.parse
import urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler

AZURE_MGMT = "https://management.azure.com"
AZURE_LOGIN = "https://login.microsoftonline.com"


def get_token(tenant_id, client_id, client_secret):
    url = f"{AZURE_LOGIN}/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "grant_type":    "client_credentials",
        "client_id":     client_id,
        "client_secret": client_secret,
        "scope":         "https://management.azure.com/.default",
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())["access_token"]


def fetch_skus(subscription_id, token):
    skus = []
    url = (
        f"{AZURE_MGMT}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Compute/skus"
        f"?api-version=2021-07-01"
        f"&$filter=resourceType eq 'virtualMachines'"
    )
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
        skus.extend(data.get("value", []))
        url = data.get("nextLink")
    return skus


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/skus":
            self.send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))

        sub_id        = body.get("subscriptionId", "").strip()
        tenant_id     = body.get("tenantId", "").strip()
        client_id     = body.get("clientId", "").strip()
        client_secret = body.get("clientSecret", "").strip()

        if not all([sub_id, tenant_id, client_id, client_secret]):
            self.send_json(400, {"error": "All fields are required."})
            return

        try:
            token = get_token(tenant_id, client_id, client_secret)
            skus  = fetch_skus(sub_id, token)
            self.send_json(200, {"value": skus})
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            self.send_json(e.code, {"error": detail})
        except Exception as e:
            self.send_json(500, {"error": str(e)})

    def do_GET(self):
        # Serve static files for everything else
        super().do_GET()


if __name__ == "__main__":
    port = 3000
    server = HTTPServer(("", port), Handler)
    print(f"Azure VM SKU Explorer running at http://localhost:{port}")
    print("Press Ctrl+C to stop.\n")
    server.serve_forever()
