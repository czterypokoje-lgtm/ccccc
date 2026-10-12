#!/bin/sh
# Entrypoint that makes the host IP physically unable to leave the container.
#
# Everything outbound is DROPped except the proxy endpoint. Not "configured to
# use the proxy" -- unable to reach anything else. If the proxy dies, packets
# stop; they never fall through to a direct connection.
#
# Refuses to start the server unless it has PROVEN both halves hold:
#   - a non-proxy host is unreachable
#   - the proxy itself is reachable
# A kill switch nobody tested is a kill switch that does not work.
#
# Needs NET_ADMIN. Run via docker-compose.proxy.yml.
set -eu

PROXY_HOST="${PROXY_HOST:-${PROXY_BACKCONNECT_HOST:-}}"
[ -n "$PROXY_HOST" ] || {
  echo "killswitch: PROXY_HOST (or PROXY_BACKCONNECT_HOST) is required." >&2
  echo "killswitch: refusing to run unprotected -- that is the whole point of this file." >&2
  exit 1
}

# Every port the server may dial, not just one. lib/config.js feeds PROXY_PORTS
# into a pool that lib/proxy.js rotates across (`ports[index % ports.length]`),
# so opening a single port silently drops every session assigned any other one
# -- which looks like random navigation timeouts, not like a firewall.
# Backconnect default mirrors lib/config.js (`PROXY_BACKCONNECT_PORT || 7000`);
# diverging from it turns a valid .env into a crash loop under compose.
PORT_LIST="${PROXY_PORTS:-${PROXY_PORT:-${PROXY_BACKCONNECT_PORT:-7000}}}"
PORT_LIST=$(echo "$PORT_LIST" | tr ',' ' ' | tr -s ' ')
for p in $PORT_LIST; do
  case "$p" in
    ''|*[!0-9]*) echo "killswitch: bad proxy port '$p'" >&2; exit 1 ;;
  esac
done
[ -n "$PORT_LIST" ] || { echo "killswitch: no proxy port resolved" >&2; exit 1; }

# Resolve BEFORE locking down: once OUTPUT is DROP, there is no DNS.
# Every A record, because backconnect gateways round-robin across several.
PROXY_IPS=$(getent ahostsv4 "$PROXY_HOST" | awk '{print $1}' | sort -u)
[ -n "$PROXY_IPS" ] || { echo "killswitch: cannot resolve $PROXY_HOST" >&2; exit 1; }
echo "killswitch: proxy $PROXY_HOST ports [$PORT_LIST] -> $(echo "$PROXY_IPS" | tr '\n' ' ')"

# ---- IPv4: deny by default -------------------------------------------------
iptables -P OUTPUT DROP
iptables -P INPUT DROP
iptables -P FORWARD DROP

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

for ip in $PROXY_IPS; do
  for port in $PORT_LIST; do
    iptables -A OUTPUT -d "$ip" -p tcp --dport "$port" -j ACCEPT
  done
done

# Let the host reach the API. RFC1918 only: this is the docker bridge, not the internet.
iptables -A INPUT -p tcp --dport "${CAMOFOX_PORT:-9377}" -s 172.16.0.0/12 -j ACCEPT
iptables -A INPUT -p tcp --dport "${CAMOFOX_PORT:-9377}" -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport "${CAMOFOX_PORT:-9377}" -s 192.168.0.0/16 -j ACCEPT

# Note what is deliberately absent: no port 53 rule. DNS cannot leave this
# container at all, so name resolution for target sites HAS to happen at the
# proxy. A SOCKS client that tried to resolve locally would simply fail --
# the firewall enforces remote DNS instead of trusting a browser pref.

# ---- IPv6: no proxy speaks it here, so kill it entirely --------------------
# This is the leak everyone forgets: a v4-only proxy leaves v6 to go direct.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -P INPUT  DROP 2>/dev/null || true
  ip6tables -P FORWARD DROP 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -A INPUT  -i lo -j ACCEPT 2>/dev/null || true
fi

# ---- Prove it, or refuse to boot -------------------------------------------
echo "killswitch: verifying..."

# 1. A host that is not the proxy must be unreachable.
#
#    Probed by literal IP, never by hostname. DNS is blocked by design here, so
#    a hostname probe fails at resolution whether or not the packet filter works
#    -- it would print "ok" over a wide-open firewall. Dialling 1.1.1.1 and
#    9.9.9.9 directly tests the only thing that matters: can a packet leave for
#    an address that is not the proxy.
for probe in 1.1.1.1 9.9.9.9; do
  for pport in 443; do
    if nc -z -w 4 "$probe" "$pport" 2>/dev/null; then
      echo "killswitch: FAILED -- opened $probe:$pport, which is not the proxy." >&2
      echo "killswitch: the packet filter is NOT holding. Check that NET_ADMIN is granted" >&2
      echo "killswitch: and that this image's iptables matches the host (nft vs legacy)." >&2
      exit 1
    fi
  done
done
echo "  ok    direct internet blocked (probed by IP, not hostname)"

# 1b. DNS must be dead too, so resolution can only happen at the proxy.
#     Tested by attempting a real lookup of a name not resolved earlier in this
#     script -- not with `nc -z -u 53`, which succeeds against a DROPped UDP
#     port (no ICMP comes back, so nc sees nothing to fail on) and would abort
#     every boot.
if getent ahostsv4 example.com >/dev/null 2>&1; then
  echo "killswitch: FAILED -- resolved example.com, so DNS is leaving directly." >&2
  exit 1
fi
echo "  ok    direct dns blocked"

# 2. The proxy must be reachable, or the container is just broken.
reachable=0
for ip in $PROXY_IPS; do
  for port in $PORT_LIST; do
    if nc -z -w 5 "$ip" "$port" 2>/dev/null; then reachable=1; break 2; fi
  done
done
[ "$reachable" = 1 ] || {
  echo "killswitch: FAILED -- proxy $PROXY_HOST on ports [$PORT_LIST] is not reachable" >&2
  echo "killswitch: through the rules. Either the proxy is down or the ACCEPT rules are wrong." >&2
  exit 1
}
echo "  ok    proxy reachable"
echo "killswitch: armed. Nothing but the proxy can be reached from this container."

exec "$@"
