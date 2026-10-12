# camofox-browser terminal helpers.  Usage:  source cf.sh
# Needs: curl + python3 (no jq, no npm deps).
CF=${CF:-http://localhost:9377}
U=${U:-me}

_j(){ python3 -c 'import json,sys;print(json.dumps(dict(a.split("=",1) for a in sys.argv[1:])))' "$@"; }
_r(){ python3 -c 'import json,sys
d=json.load(sys.stdin); k=sys.argv[1] if len(sys.argv)>1 else None
print(d.get(k,"") if k else json.dumps(d,indent=1))' "$@"; }

cf_new(){  # cf_new [url] -> sets $TAB
  TAB=$(_j userId=$U sessionKey=s1 ${1:+url=$1} \
    | curl -s -m 180 -X POST $CF/tabs -H 'content-type: application/json' -d @- | _r tabId)
  export TAB; echo "TAB=$TAB"; }
cf_go(){    _j userId=$U url="$1"     | curl -s -m 180 -X POST $CF/tabs/$TAB/navigate -H 'content-type: application/json' -d @-; echo; }
cf_search(){ _j userId=$U macro=@google_search query="$1" | curl -s -m 180 -X POST $CF/tabs/$TAB/navigate -H 'content-type: application/json' -d @-; echo; }
cf_js(){    _j userId=$U expression="$1" | curl -s -m 120 -X POST $CF/tabs/$TAB/evaluate -H 'content-type: application/json' -d @- | _r result; }
cf_text(){  cf_js 'document.body.innerText'; }
cf_url(){   cf_js 'location.href'; }
cf_snap(){  curl -s -m 120 "$CF/tabs/$TAB/snapshot?userId=$U&format=text&offset=${1:-0}" | _r snapshot; }
cf_click(){ _j userId=$U selector="$1" | curl -s -m 120 -X POST $CF/tabs/$TAB/click -H 'content-type: application/json' -d @-; echo; }
cf_type(){  _j userId=$U selector="$1" text="$2" | curl -s -m 120 -X POST $CF/tabs/$TAB/type -H 'content-type: application/json' -d @-; echo; }
cf_shot(){  curl -s -m 120 "$CF/tabs/$TAB/screenshot?userId=$U" -o "${1:-shot.png}"; echo "${1:-shot.png}"; }
cf_close(){ curl -s -X DELETE "$CF/tabs/$TAB?userId=$U"; echo; }
cf_health(){ curl -s $CF/health | _r; }

# THE proxy check: what IP does the browser actually show?
cf_ip(){ cf_go 'https://api.ipify.org?format=json' >/dev/null; cf_text; }

# Click only if present. A cf_click on a missing selector blocks 30s and the
# server then destroys the tab (reason: operation_timeout) -- which is how a
# consent banner that was already dismissed kills the whole session.
cf_click_if(){ cf_js "var b=document.querySelector('$1'); b?(b.click(),'clicked'):'absent'"; }

# cf_scroll            -> one screen down
# cf_scroll bottom|top -> jump to the end/start
# cf_scroll 3          -> three screens down
cf_scroll(){ case "${1:-1}" in
  bottom) cf_js 'window.scrollTo(0,document.body.scrollHeight);"bottom"';;
  top)    cf_js 'window.scrollTo(0,0);"top"';;
  *)      cf_js "window.scrollBy(0,innerHeight*${1:-1});'scrolled'";;
esac; }

# Grab every price-looking string on the page.
cf_prices(){ cf_js '(document.body.innerText.match(/(?:€\s?[0-9][0-9.,]*|[0-9][0-9.,]*\s?€)/g)||[]).join("\n")'; }

# Wait until some text appears (default 20s), instead of guessing with sleep.
cf_wait_text(){ for i in $(seq 1 "${2:-20}"); do
  case "$(cf_js "document.body.innerText.indexOf('$1')>=0?'y':'n'")" in y) echo found; return 0;; esac
  sleep 1; done; echo "timeout waiting for: $1"; return 1; }
