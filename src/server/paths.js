// Oracle 서버의 data/ 아래 «선반» 위치를 한곳에서 정합니다.
// 번호는 배치가 지나가는 순서입니다. 폴더를 열어 보면 순서대로 정렬되어 보입니다.
//
//   1_inbox     Mac이 올린 그대로 (아직 검수 전)
//   2_accepted  검수 통과한 원본. 고치지 않는 보관본 (파일은 읽기 전용으로 잠급니다)
//   3_rejected  검수 탈락. 폴더 안 REJECTED.txt 에 이유가 있습니다
//   4_db        SQLite. 원본(2_accepted)에서 언제든 다시 만들 수 있는 사본입니다

import path from "node:path";

export const SHELVES = {
  inbox: "1_inbox",
  accepted: "2_accepted",
  rejected: "3_rejected",
  db: "4_db",
};

export const DB_FILE_NAME = "tapioca.sqlite";

export function dataPaths(root = "data") {
  const base = path.resolve(root);
  return {
    root: base,
    inbox: path.join(base, SHELVES.inbox),
    accepted: path.join(base, SHELVES.accepted),
    rejected: path.join(base, SHELVES.rejected),
    dbDir: path.join(base, SHELVES.db),
    dbFile: path.join(base, SHELVES.db, DB_FILE_NAME),
  };
}

export const SHELF_NOTES = {
  inbox: "여기는 «받은 편지함»입니다. Mac mini가 push 로 올린 배치 폴더가 그대로 들어옵니다.\n검수(npm run receive)가 돌면 이 폴더는 비워지고 배치는 2_accepted 나 3_rejected 로 옮겨집니다.\n이름이 .partial 로 끝나는 폴더는 전송 중이라 건드리지 않습니다.\n",
  accepted: "여기는 «검수 통과 원본 보관함»입니다. 폴더 하나 = 수집 한 번.\n파일은 읽기 전용으로 잠겨 있고, 고치지 않습니다(고쳐야 하면 새로 수집해서 새 이름으로 받습니다).\n4_db 의 SQLite 가 망가져도 여기 원본으로 다시 만들 수 있습니다.\n",
  rejected: "여기는 «검수 탈락 보관함»입니다. 폴더마다 REJECTED.txt 에 탈락 이유가 적혀 있습니다.\n이 폴더의 데이터는 어디에도 쓰이지 않습니다. 이유를 확인하고 Mac에서 다시 수집해 올리면 됩니다.\n",
  db: "여기는 SQLite 가 있는 곳입니다(tapioca.sqlite). 계산·후보·모의매매 기록이 이 파일에 쌓입니다.\n원본이 아니라 «사본»이라서, 지우고 npm run receive -- --rebuild 로 2_accepted 에서 다시 만들 수 있습니다.\n",
};
