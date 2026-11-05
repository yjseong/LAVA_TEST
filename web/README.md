# L.A.V.A. Home — Next.js / React 버전

Python(Dash)으로 만든 Home 화면(세계 지도, VAAC 말풍선, 오른쪽 Volcano & Alerts 패널, 미니맵)을
**Next.js 16 + React 19 + react-leaflet**으로 옮기고 Vercel에 올릴 수 있게 한 버전입니다.
변환 전 원본 Python 코드는 이 저장소에 포함하지 않습니다(배포에 필요하지 않기 때문입니다). Git 이력에는 남아 있어서
커밋 `60a30d4`의 `original_python/`(그 이전 `a2b5cbe`에는 저장소 루트)에서 그대로 꺼낼 수 있습니다:
`git checkout 60a30d4 -- original_python`. 이 문서의 "Python 원본" 설명과 아래 일부 스크립트는 그 원본을 기준으로 합니다.

## 실행

Node.js 20.9 이상이 필요합니다.

```bash
cd web
npm install
cp .env.example .env.local     # 로컬에서는 비워 둬도 됩니다
npm run dev                    # http://localhost:3000
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` / `npm start` | 운영 빌드 / 실행 |
| `npm run typecheck` | 타입 검사 |
| `npm test` | 테스트 (Python 원본과의 판정 일치 검사 포함) |
| `npm run build:master` | `volcano_master_all.xlsx` → `src/data/volcanoes.json` 다시 만들기 |

처음 열면 자료를 가져오느라 수 초~수십 초 걸릴 수 있습니다(원본과 같음). 이후에는 저장된 직전 자료로 바로 뜹니다.

## 구조 — Python 원본과의 대응

| Python 원본 | 이 버전 |
|---|---|
| `app.py` (상단 메뉴, 페이지 잠금) | `src/app/layout.tsx`, `src/components/SiteHeader.tsx` — Home만 링크, 나머지 메뉴는 흐리게 |
| `pages/home.py` 레이아웃·콜백 | `src/components/home/HomeView.tsx` 외 (지도, 마커, 말풍선, 범례, 사이드 패널, 미니맵, 시계) |
| `pages/home.py` 판정 함수 (`_vaa_status`, `_official_alert` …) | `src/lib/alertLogic.ts` |
| `assets/home_bubbles.js` (말풍선 겹침 정리) | `src/lib/bubbles.ts` |
| `assets/home_clock.js` | `src/components/home/ClockBar.tsx` |
| `assets/home_layout.css`, `blink.css` | `src/app/home.css` |
| `volcano_data.py`, `volcano_official_collectors.py` (수집) | `src/server/collectors/*.ts` |
| `volcano_alert_registry.py` (경보·이력 저장) | `src/server/registry.ts`, `src/server/store.ts` |
| `_refresh_sources()` + 60초 백그라운드 스레드 | `src/server/refresh.ts` (+ 아래 "갱신 방식") |
| `volcano_master_all.xlsx` + pandas | `src/data/volcanoes.json` (스크립트로 변환) |
| Dash 콜백 / `dcc.Store` | React 상태 + `/api/*` 라우트 |

## 갱신 방식 (Vercel에는 상주 프로세스가 없습니다)

Python은 서버 안의 스레드가 60초마다 자료를 가져왔습니다. 서버리스에는 그런 스레드가 없어서 이렇게 바꿨습니다.

- 저장된 자료가 **5분 이내**이면 그대로 돌려줍니다(원본은 60초). 무료 Redis의 월 명령 수 한도를 지키기 위해 늘렸습니다.
  VAA는 화산마다 몇 시간 간격으로 발행돼서 5분 차이는 화면에서 거의 보이지 않습니다. 주기는 `src/server/payload.ts`의 `REFRESH_AFTER_MS`입니다.
- 더 **오래됐으면** 그 자료를 먼저 돌려주고, 응답이 끝난 뒤에 백그라운드로 새로 받아 둡니다(다음 방문자가 새 자료를 봅니다).
- 저장된 자료가 **아예 없으면**(첫 실행) 첫 수집이 끝날 때까지 기다립니다(최대 45초).
- 화면의 **↻ Refresh** 버튼은 지금 바로 갱신합니다(15초에 한 번만).
- PVMBG·KVERT·PHIVOLCS는 30분 간격(실패하면 5분 뒤 재시도), JMA는 10분 캐시 — 원본과 같습니다.
- 방문자가 없는 시간에는 갱신되지 않습니다. 항상 따뜻하게 두려면 Vercel Cron을 쓰세요(아래).

### Redis 명령 사용량 (Upstash 무료 플랜: 월 50만 명령)

Upstash는 파이프라인 안의 명령까지 하나씩 셉니다. 실제 자료로 측정한 값(`src/server/usage.test.ts`가 상한을 지킵니다):

| 동작 | 명령 수 |
|---|---|
| 서비스 시작 후 첫 수집(1회) | 약 860 |
| 수집했는데 바뀐 게 없을 때 | 7 |
| 새 VAA가 1건 생겨 수집할 때 | 약 17 |
| 방문자 1명의 `/api/alerts` | 1 |
| 방문자 1명의 이력 조회(`/api/events`) | 2 |

24시간 내내 접속이 있어도 하루 수천 명령, 월 20만 안팎이라 무료 한도 안입니다(방문자 수에 따라 달라집니다).
이력을 저장할 때 이미 있는 행을 `HSETNX`로 하나씩 확인하면 새 VAA 1건에 약 230명령이 들었기 때문에, `HMGET` 한 번으로 먼저 확인합니다.

### Redis가 고장 나거나 한도를 넘으면

`src/server/resilientStore.ts`가 저장소 호출을 감쌉니다. Redis 호출이 오류(연결 실패, 인증 오류, 한도 초과)이거나 5초 안에 답이 없으면
그 요청은 **서버 메모리**로 처리하고, 30초 동안은 Redis를 건드리지 않다가 다시 시도해 살아났으면 자동으로 돌아옵니다. 그래서 `/api/alerts`가 500을 내지 않고 지도가 계속 뜹니다.

- 메모리로 동작하는 동안에는 이력이 서버 인스턴스마다 따로이고, 인스턴스의 첫 요청은 직접 수집하느라 느립니다(Vercel에서 약 4초).
- 그 사이 메모리에 쓴 내용은 Redis가 돌아와도 옮기지 않습니다(작고, 다음 수집이 현재 상태를 다시 만듭니다).
- `/api/alerts` 응답 헤더 `X-Store`로 지금 어느 저장소가 답했는지 볼 수 있습니다(`upstash` 정상, `memory` 대체 중).
  원인은 Vercel 로그에 `[store] upstash unavailable ...`로 남습니다.

## 환경 변수

`.env.example` 참고. Vercel에서는 Project Settings → Environment Variables.

| 변수 | 필수 | 설명 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **Vercel에서 필수** | 경보 상태·이력·직전 스냅샷 저장소. Marketplace의 *Upstash for Redis*를 연결하면 자동으로 들어갑니다(`KV_REST_API_URL/TOKEN` 이름도 인식). 없으면 로컬은 파일(`.data/`), Vercel은 메모리에 저장해서 **재시작·인스턴스 교체 때마다 이력이 사라집니다** |
| `CRON_SECRET` | Cron을 쓸 때 필수 | `/api/cron/refresh` 보호용. Vercel에서 이 값이 없으면 그 주소는 401로 거부됩니다(공개 주소라 누구나 자료원 사이트를 두드리게 되는 걸 막기 위해). 로컬에서는 없어도 열려 있습니다 |
| `VAA_DB_URL` | 선택 | 내부 VAA 데이터베이스(`mysql://user:pass@host:3306/VAAC`). 연구원 내부망에 있어 Vercel에서는 닿지 않습니다 |
| `VOLCANO_PVMBG_ALLOW_UNVERIFIED` | 선택 | PVMBG 사이트 인증서 검증이 실패할 때만 `1`. 호스트와 인증서 체인을 확인한 뒤에만 쓰세요 |
| `LAVA_DATA_DIR`, `LAVA_KEY_PREFIX`, `LAVA_EVENT_RETENTION_DAYS` | 선택 | 로컬 파일 위치, Redis 키 접두어, 이력 보관 일수(기본 45일) |

## Vercel 배포

1. 이 저장소를 GitHub 등에 올리고 Vercel에서 **Add New → Project**로 가져옵니다.
2. **Root Directory**를 `web`으로 지정합니다. Framework는 Next.js로 자동 인식됩니다.
3. Project → **Storage** → **Upstash for Redis**(Marketplace)를 만들어 이 프로젝트에 연결합니다. 환경 변수가 자동으로 들어갑니다.
4. (Cron을 쓸 때만) `CRON_SECRET`을 임의의 긴 문자열로 설정합니다.
5. **Deploy**. 배포 후 `https://<도메인>/api/alerts`가 JSON을 돌려주는지 확인합니다.

CLI로 올리려면 `web` 폴더에서 `npx vercel` (미리보기), `npx vercel --prod` (운영).

### 일정 갱신(Cron, 선택)

방문자가 없어도 자료를 최신으로 유지하려면 `web/vercel.json`에 다음을 추가합니다.
**Hobby 플랜은 하루 1회까지만 허용되고, 그보다 잦은 식을 넣으면 배포가 실패합니다.** 1분 간격은 Pro 플랜부터입니다.

```json
{ "crons": [{ "path": "/api/cron/refresh", "schedule": "* * * * *" }] }
```

### 지역(Region)

기본 함수 지역은 미국 동부(iad1)입니다. 자료원이 일본·호주·인도네시아에 있고 사용자가 한국이라면
Project Settings → Functions → Function Region을 **Tokyo (hnd1)** 로 바꾸는 편이 빠릅니다.

## 원본과 다른 점

- **JMA 경보**: 원본은 Selenium + Chrome으로 JMA 지도 페이지를 읽었습니다. 서버리스에서는 Chrome을 띄울 수 없어
  JMA가 공개하는 JSON 데이터를 직접 읽습니다(`src/server/collectors/jma.ts`).
- **SSL 검증**: 원본의 `VERIFY_SSL = False`(연구원 SSL 검사 우회)는 제거했습니다. Vercel에는 그런 프록시가 없어 필요 없고, 검증을 끄는 건 위험하기 때문입니다.
- **저장소**: SQLite/JSON 파일 → Redis. 서버리스는 디스크가 유지되지 않습니다.
- **화산 좌표·고도**: 원본 큰 말풍선은 이름이 일부만 같은 화산을 잘못 찾을 수 있었는데(`str.contains`), 여기서는 화산 번호로 정확히 찾습니다.
- **선택 시 지도 이동**: 기능 명세에는 "줌 8로 이동"이라고 되어 있지만 실제 원본 코드는 줌을 바꾸지 않고 옆으로만 이동합니다. 코드 동작을 따랐습니다.
- **"Open Seismic" 버튼**: Seismic 페이지가 이 패키지에 없어 큰 말풍선에서 뺐습니다.
- **Bootstrap**: Dash용 Bootstrap 테마 대신 필요한 부분(리셋, 스위치, 셀렉트)만 CSS로 재현했습니다.

## 검증

- `npm test` — `scripts/gen-python-reference.py`가 **Python 원본 함수를 그대로 실행**해 만든 기준값
  (`src/lib/__fixtures__/python-reference.json`, 2026-10-30 스냅샷)과 TS 결과를 비교합니다. 화산 1,261개의 삼각형 크기·색·테두리·말풍선,
  상태 문구, 99개 시간 표기가 모두 같아야 통과합니다. 기준값 파일은 저장소에 들어 있어서 **원본이 없어도 `npm test`는 그대로 동작합니다.**
  기준값을 다시 만들려면 원본이 `../original_python/`에 있어야 합니다(위 `git checkout` 참고): `python web/scripts/gen-python-reference.py` (pandas 필요).
- `npx tsx scripts/smoke-sources.ts` — 모든 외부 소스를 실제로 호출해 행 수와 샘플을 출력합니다(원본의 스냅샷이 있으면 비교도 합니다).
- `npm run build:master` — 화산 목록을 다시 만들 때만 씁니다. 원본의 `volcano_master_all.xlsx` 경로를 인자로 주세요
  (`npm run build:master -- <xlsx 경로>`). 결과(`src/data/volcanoes.json`)는 저장소에 들어 있어서 평소에는 필요 없습니다.

## 알려진 한계

- 연구원망 밖(Vercel)에서 접속하므로 자료원 사이트가 해외 IP를 막거나 느리면 해당 소스만 비게 됩니다. 소스별 상태는 오른쪽 패널 아래쪽(`JMA: ok · PVMBG: ok …`)에 표시됩니다.
- 오래된 공식 경보는 6시간이 지나면 STALE로 표시하고 색을 지웁니다(원본과 같음).
- 이력(DB)은 첫 실행부터 쌓입니다. 원본 `cache/volcano_alerts.sqlite3`의 이력은 옮기지 않았습니다.
