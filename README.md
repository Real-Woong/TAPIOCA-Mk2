# TAPIoca_ver2

NASDAQ 거래량 급증 → 횡보 → 돌파 스크리너. **부모 폴더의 ETF 자동매매(toss-ai-agent)와 코드·`package.json`·`data/`가 전부 따로입니다.**
이 폴더 안에서 `npm`을 실행하세요(부모 폴더의 `npm test`는 이 폴더를 보지 않습니다).

## 어느 기기에서 무엇을 돌리나

| 기기 | 명령 | 하는 일 |
|---|---|---|
| Mac mini | `npm run collect -- --mode backfill` | 종목·일봉 수집 → `data/outbox/<배치>/` |
| Mac mini | `SCREENER_SERVER=ubuntu@<주소> npm run push -- data/outbox/<배치>` | 서버 `data/1_inbox/` 로 전송 |
| Oracle | `npm run receive` | 검수 → 보관 → SQLite 적재 |
| Oracle | `npm run status` | DB에 뭐가 들어 있는지 보기 |
| Oracle | `npm run scan` | 발견 조건(5개)을 걸었을 때 몇 건이 남는지 (읽기 전용) |
| Oracle | `npm run candidates` | 후보 상태 머신 실행 — 확인·박스·돌파 추적, 사건 기록 |
| Oracle | `npm run paper` | 모의매매(가상 계좌, 토스 수수료·장 일정을 읽어 반영) — 돌파 신호의 다음 날 시가 체결, 청산(손절 포함)은 «종가 판단 → 다음 날 시가», 계좌 평가 |
| Oracle | `npm run report` | 텔레그램 일일 보고 (`-- --dry` 시험 출력, `-- --watchdog` 수집 지연 경고) |
| Oracle | `npm run fractional -- 종목 ok\|no` | 신호 종목이 앱에서 «금액으로 사기» 되는지 기록(`list` 로 보기). `no` 로 적은 종목은 모의가 건너뜀 |
| Oracle | `npm run candles-compare` | 토스 일봉과 우리 DB(Yahoo)를 비교 — 읽기 전용, 저장 안 함 |
| Mac mini | `npm run sync` | 코드를 서버로 올리기 (`-- --dry` 로 미리보기). 주소는 `.env.local` 의 `SCREENER_SERVER` |
| Mac mini | `npm run server -- "npm run report -- --dry"` | 서버에서 명령 한 줄 실행 (인자 없으면 서버 로그인) |
| 어디서나 | `npm run probe` / `npm test` | 접근 시험 / 이 폴더의 시험 |

## 폴더 지도

```
TAPIoca_ver2/
├── src/
│   ├── collect/     ← Mac mini 용: 수집기 (Yahoo → 일봉)
│   ├── server/      ← Oracle 용: 검수(validate)·보관(receive)·SQLite(db)
│   ├── compute/     ← 지표(indicators)·고정값(settings)·깔때기(scan)·시장 전체 폭(breadth, 기록 전용)
│   ├── candidates/  ← 후보 상태 머신: step(한 칸) · replay(종목 하나 전체) · runner(DB 기록)
│   ├── broker/      ← 토스에서 «읽기만 해서» 받는 규칙: rules(수수료·장 일정 해석) · refresh(저장)
│   ├── toss/        ← 토스 읽기 전용 클라이언트 (토큰 발급 외 주문 코드 없음)
│   ├── notify/      ← 텔레그램: telegram(전송) · format(문구) · report(모으기·표식) · report-cli
│   └── paper/       ← 모의매매: settings(고정값) · rules(규칙) · engine(가상 계좌) · paper-cli
├── test/
│   ├── collect/     수집기 시험
│   ├── server/      검수·적재 시험
│   ├── compute/     지표·분할 감지 시험
│   ├── candidates/  상태 머신 시험
│   ├── notify/      보고 문구·전송·표식 시험
│   └── paper/       모의매매 규칙·엔진 시험
├── scripts/         access-probe.mjs(접근 시험), push.sh(Mac→Oracle 전송)
├── docs/            PIPELINE.md(먼저 읽기), STRATEGY_SPEC.md(전략 원문)
└── data/            실행 결과 (git 무시)
    ├── outbox/          [Mac]    수집 결과가 나오는 곳. 서버 적재를 확인하기 전엔 지우지 마세요
    ├── 1_inbox/         [Oracle] ① 받은 그대로 (검수 전)
    ├── 2_accepted/      [Oracle] ② 검수 통과한 원본 — 고치지 않는 보관본(읽기 전용)
    ├── 3_rejected/      [Oracle] ③ 탈락. 폴더마다 REJECTED.txt 에 이유
    └── 4_db/            [Oracle] ④ tapioca.sqlite (원본에서 언제든 다시 만드는 사본)
```

배치 하나(수집 한 번)가 지나가는 길: `outbox` → (push) → `1_inbox` → (receive) → `2_accepted` 또는 `3_rejected` → `4_db`.
각 `data/` 하위 폴더 안에 `_이_폴더는_무엇.txt` 가 있어서 열어 보면 설명이 나옵니다.

## 검수 기준 (receive)

통과해야 하는 것 전부: manifest 있음 · 상태 COMPLETE/PARTIAL(ABORTED 거부) · 두 파일의 sha256 일치 · 줄 수·건수 일치 ·
대상 목록에 없는 종목/중복 종목 없음 · 봉 값 정상(양수, 고가≥종가 등, 날짜 오름차순) · 빠진 종목 ≤ 2%(`--max-missing`) · 같은 이름 배치가 보관돼 있지 않음.
하나라도 어긋나면 그 배치는 통째로 `3_rejected` 로 갑니다(일부만 받지 않습니다).

## SQLite 핵심

- `bars`는 **바뀐 것만** 쌓습니다. 매일 겹쳐 받는 봉이 같으면 저장하지 않고, 값이 달라지면 새 줄 + `bar_corrections` 에 기록합니다.
- 계산은 `latest_bars` 뷰만 읽으면 됩니다(같은 종목·날짜의 최신 값).
- 가격은 소수 4자리로 반올림해 저장합니다. 원본 JSONL은 그대로입니다.
- DB가 이상하면 `npm run receive -- --rebuild` (DB를 지우고 `2_accepted` 에서 다시 만듭니다).

## Node 버전

- 수집(`src/collect`): Node 20.12+
- 서버 SQLite(`src/server`): **Node 22.13+** (내장 `node:sqlite` 사용, 의존성 없음). 서버 `node -v` 가 이보다 낮으면 `receive` 가 안내와 함께 멈춥니다.

Oracle 위치: `/home/ubuntu/toss-api/apps/TAPIOCA_ver2/` (예전 ETF Ver2 파일을 비우고 이 프로젝트만 둡니다). ETF 실거래 `toss-ai-agent/` 와는 계속 별개입니다.
