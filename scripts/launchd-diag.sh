#!/usr/bin/env bash
#
# launchd 로 돌렸을 때 «어느 단계에서 멈추는가»를 가려내는 진단입니다 (수집·전송은 하지 않음, 읽기만).
#   bash scripts/launchd.sh diag     → 결과: ~/Library/Logs/tapioca-ver2/diag.log
#
# 단계마다 10초 제한을 걸어, 멈추면 «멈춤» 으로 표시하고 다음 단계로 넘어갑니다. 확인하는 것:
#   1 node 실행 자체   2 node 가 Desktop 폴더를 읽기   3 node 가 Desktop 의 소스 파일을 불러오기
#   4 node 의 인터넷 접속   5 curl 의 인터넷 접속   6 서버 ssh 접속
# 멈추는 첫 단계가 원인의 위치입니다 (예: 3 에서 멈추면 Desktop 접근 권한, 4 만 멈추면 네트워크).
#
# 0 단계(A·B·C)는 «작업 폴더가 Desktop 이어서 멈추는가»를 가르는 비교입니다. 같은 node 를 작업 폴더만 바꿔 돌립니다.
#   0A 통과 + 1 멈춤 → Desktop 폴더 접근 권한 때문 (macOS 가 허용 창을 띄우고 답을 기다리는 중)
#   0A 도 멈춤       → node 실행 자체 문제(보안 검사 등)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
[[ -f .env.local ]] && set -a && source .env.local && set +a

say() { echo "[$(date '+%H:%M:%S')] $*"; }
# 제한 시간 안에 안 끝나면 SIGALRM(142)으로 죽인다 — macOS 에 timeout 명령이 없어 perl 로 대신한다
lim() { perl -e 'alarm shift; exec @ARGV' 20 "$@"; }
step() {
  local title="$1"; shift
  say "▶ $title"
  lim "$@" 2>&1 | sed 's/^/     /'
  local code=${PIPESTATUS[0]}
  if [[ $code -eq 142 ]]; then say "  ✖ 멈춤 (10초 안에 안 끝남)"; elif [[ $code -ne 0 ]]; then say "  ✖ 실패 (코드 $code)"; else say "  ✔ 통과"; fi
}

# 한 단계가 멈춰도 다음으로 넘어가도록 제한 시간을 짧게(10초) 쓴다
lim() { perl -e 'alarm shift; exec @ARGV' 10 "$@"; }

say "진단 시작 · 사용자 $(id -un) · 작업 폴더 $(pwd) · bash $BASH_VERSION"
step "0A 작업 폴더를 / 로 두고 node 실행"          bash -c 'cd / && exec node -e "console.log(\"node\", process.version, \"cwd=\", process.cwd())"'
step "0B 작업 폴더를 /tmp 로, node 전체 경로로 실행"  bash -c 'cd /tmp && exec /opt/homebrew/bin/node -v'
step "0C node 파일의 실제 위치와 서명"              bash -c 'f=$(readlink -f /opt/homebrew/bin/node); echo "$f"; codesign -dv "$f" 2>&1 | head -4'
# 0D·0E: 작업 폴더는 / 로 두고 node 가 Desktop 의 «파일»을 읽고 쓰는 것까지 되는가 → 되면 폴더를 옮기지 않고 daily.sh 만 고치면 된다
export ROOT
step "0D 작업 폴더 / 에서 Desktop 의 소스 불러오기"   bash -c 'cd / && exec node --input-type=module -e "await import(\"file://\" + process.env.ROOT + \"/src/collect/universe.js\"); console.log(\"import 성공\")"'
step "0E 작업 폴더 / 에서 Desktop 에 파일 쓰기·읽기"   bash -c 'cd / && exec node -e "const fs=require(\"node:fs\"); const f=process.env.ROOT+\"/data/logs/.diag-write\"; fs.writeFileSync(f,\"ok\"); console.log(\"쓰기·읽기\", fs.readFileSync(f,\"utf8\")); fs.rmSync(f)"'
step "1 node 실행(작업 폴더 = Desktop)"                 node -e 'console.log("node", process.version)'
step "2 node 가 Desktop 폴더 읽기"  node -e 'console.log("src 항목", require("node:fs").readdirSync("src").length)'
step "3 node 가 Desktop 소스 불러오기" node --input-type=module -e 'await import("./src/collect/universe.js"); console.log("import 성공")'
step "4 node 인터넷 접속(종목표)"    node -e 'fetch("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",{signal:AbortSignal.timeout(15000)}).then(r=>console.log("HTTP",r.status)).catch(e=>{console.log("실패",e.message);process.exit(1)})'
step "5 curl 인터넷 접속(종목표)"    curl -sS -m 15 -o /dev/null -w "HTTP %{http_code}\n" https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
step "6 서버 ssh 접속"              ssh -o BatchMode=yes -o ConnectTimeout=10 "${SCREENER_SERVER:-x}" 'echo 서버 접속 OK'
say "진단 끝"
