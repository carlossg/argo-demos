#!/usr/bin/env python3
"""Point hostnames at an IP by upserting Cloudflare A records.

Usage: cloudflare-dns.py <ip> <host> [<host>...]
Token: CLOUDFLARE_API_TOKEN or CF_API_TOKEN, from the environment or a .env file
(rollouts-demo/.env or ../.env).
Optional: CLOUDFLARE_ZONE (default csanchez.org), DRY_RUN=1.
The token needs Zone:Read and DNS:Edit on the zone.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"


def load_token():
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN", "")
    if token:
        return token
    here = os.path.dirname(os.path.abspath(__file__))
    for env in (os.path.join(here, ".env"), os.path.join(here, "..", ".env")):
        if os.path.isfile(env):
            for line in open(env):
                key, _, value = line.strip().partition("=")
                if key in ("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN") and value:
                    return value.strip("\"'")
    return ""


TOKEN = load_token()
ZONE = os.environ.get("CLOUDFLARE_ZONE", "csanchez.org")
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def call(method, path, body=None, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Cloudflare {method} {path} failed: {e.code} {e.read().decode()[:300]}")
    if not data.get("success"):
        raise SystemExit(f"Cloudflare {method} {path} failed: {data.get('errors')}")
    return data["result"]


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    ip, hosts = sys.argv[1], sys.argv[2:]
    if not TOKEN:
        raise SystemExit("CLOUDFLARE_API_TOKEN / CF_API_TOKEN is not set")

    zones = call("GET", "/zones", params={"name": ZONE})
    if not zones:
        raise SystemExit(f"Cloudflare zone {ZONE} not found (or token lacks access)")
    zone_id = zones[0]["id"]

    for host in hosts:
        records = call("GET", f"/zones/{zone_id}/dns_records", params={"name": host})
        a_record = next((r for r in records if r["type"] == "A"), None)
        # A CNAME (or AAAA) on the same name conflicts with the A record we want.
        for r in records:
            if r["type"] in ("CNAME", "AAAA"):
                print(f"  {host}: removing {r['type']} -> {r['content']}")
                if not DRY_RUN:
                    call("DELETE", f"/zones/{zone_id}/dns_records/{r['id']}")

        payload = {"type": "A", "name": host, "content": ip, "ttl": 60,
                   "proxied": a_record["proxied"] if a_record else False}
        if a_record and a_record["content"] == ip:
            print(f"  {host}: already {ip}")
        elif a_record:
            print(f"  {host}: {a_record['content']} -> {ip}")
            if not DRY_RUN:
                call("PUT", f"/zones/{zone_id}/dns_records/{a_record['id']}", payload)
        else:
            print(f"  {host}: created A {ip}")
            if not DRY_RUN:
                call("POST", f"/zones/{zone_id}/dns_records", payload)


main()
