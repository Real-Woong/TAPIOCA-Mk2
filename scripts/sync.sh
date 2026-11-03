#!/usr/bin/env bash
#
# 이 폴더의 코드를 Oracle 서버로 올립니다 (Mac mini 에서 실행). 서버 주소는 .env.local 의 SCREENER_SERVER 를 씁니다.
#   bash scripts/sync.sh           올리기
#   bash scripts/sync.sh --dry     무엇이 올라갈지만 보기 (아무것도 바꾸지 않음)
#
# 올리지 않는 것: data(수집·DB), node_modules, probe-*.json, .env* (비밀값과 서버 쪽 데이터는 건드리지 않는다)
# 서버에만 있는 파일(src/toss, src/portfolio, .env 등)도 지우지 않는다 (--delete 를 쓰지 않음)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
[[ -f .env.local ]] && set -a && source .env.local && set +a
: "${SCREENER_SERVER:?SCREENER_SERVER 가 없습니다 — TAPIoca_ver2/.env.local 에 SCREENER_SERVER=ubuntu@<주소> 를 적으세요}"
REMOTE_DIR="${SCREENER_REMOTE_DIR:-/home/ubuntu/toss-api/apps/TAPIOCA_ver2}"

FLAGS=(-azv --exclude data --exclude node_modules --exclude 'probe-*.json' --exclude '.env*')
[[ "${1:-}" == "--dry" ]] && FLAGS+=(--dry-run)

rsync "${FLAGS[@]}" -e "ssh -o BatchMode=yes -o ConnectTimeout=20" ./ "$SCREENER_SERVER:$REMOTE_DIR/"
