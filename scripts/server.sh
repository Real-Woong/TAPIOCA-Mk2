#!/usr/bin/env bash
#
# 서버에서 명령 하나를 실행합니다 (Mac mini 에서). 서버 주소는 .env.local 의 SCREENER_SERVER.
#   bash scripts/server.sh "npm run report -- --dry --force"
#   bash scripts/server.sh                      인자가 없으면 서버에 로그인한다 (프로젝트 폴더에서 시작)
#
# 서버의 node 경로를 얻으려고 로그인 셸(bash -lc)로 실행하고, 프로젝트 폴더로 먼저 이동한다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
[[ -f .env.local ]] && set -a && source .env.local && set +a
: "${SCREENER_SERVER:?SCREENER_SERVER 가 없습니다 — TAPIoca_ver2/.env.local 에 SCREENER_SERVER=ubuntu@<주소> 를 적으세요}"
REMOTE_DIR="${SCREENER_REMOTE_DIR:-/home/ubuntu/toss-api/apps/TAPIOCA_ver2}"

if [[ $# -eq 0 ]]; then
  exec ssh -t "$SCREENER_SERVER" "cd '$REMOTE_DIR' && exec bash -l"
fi
# 서버의 비대화형 셸은 ~/.bashrc 를 건너뛰어 nvm 의 node 를 못 찾는다 — 직접 불러온다 (daily.sh 와 같은 방식)
REMOTE_ENV='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
exec ssh -o BatchMode=yes -o ConnectTimeout=20 "$SCREENER_SERVER" "bash -lc '${REMOTE_ENV}cd $REMOTE_DIR && $*'"
