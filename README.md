# L.A.V.A. Home 화면 검토용 패키지

Home 화면(세계 지도, VAAC 말풍선, 오른쪽 Volcano & Alerts 패널, 미니맵)만 따로 묶은 것입니다.
다른 메뉴(About, Ash, Data, Seismic, PMCC, Infrasound, Report)는 들어 있지 않고, 화면 위쪽 메뉴에는 흐리게 표시됩니다.

## 실행

1. Python 3.14에서 개발·확인했습니다(3.11 이상이면 될 가능성이 높지만 확인하지 않았습니다).
2. 압축을 풀고 그 폴더에서:

```
python -m venv .venv
.venv\Scriptsctivate
pip install -r requirements.txt
python app.py
```

3. 브라우저에서 `http://127.0.0.1:8050` 을 엽니다(`run_home.bat` 더블클릭으로도 시작됩니다).
   - 포트를 바꾸려면 `set LAVA_PORT=8052` 후 실행합니다.
   - 처음 열면 자료를 가져오는 데 수 초~수십 초가 걸릴 수 있습니다. 새로고침하면 됩니다.

## 필요한 환경

- **인터넷**: BoM·Tokyo VAAC, JMA, PVMBG, KVERT, PHIVOLCS, MIROVA 사이트에서 자료를 가져옵니다.
  연구원 망에서 SSL 검사 때문에 인증서 오류가 나는 곳이 있는데, 코드에서 이미 처리되어 있습니다(`volcano_data.py`의 `VERIFY_SSL`, `truststore`).
- **Chrome 브라우저**: JMA 경보는 Selenium으로 읽습니다. Chrome이 없거나 chromedriver를 받을 수 없으면 JMA 부분만 비어 보일 수 있습니다.
- **DB**: 선택한 화산의 VAA 이력은 내부 DB에서 읽는데, 접속 정보는 이 패키지에 넣지 않았습니다(`db_config.py`는 자리표시 값).
  DB가 없어도 Home은 동작하며, 그 이력만 나오지 않습니다.
- `cache/` 폴더의 파일은 만든 시점의 자료입니다. 실행하면 새 자료로 자동 갱신됩니다.

## 구성

| 파일 | 역할 |
|---|---|
| `app.py` | 앱 시작, 상단 메뉴. 원본에서 Home에 필요 없는 부분을 뺐고, 기본으로 Home만 열도록 했습니다 |
| `pages/home.py` | Home 화면 전체(지도, 말풍선, 패널, 콜백) — **검토의 중심** |
| `assets/home_layout.css`, `home_bubbles.js`, `home_clock.js`, `blink.css` | Home의 스타일, 말풍선 겹침 방지, 시계, 깜박임 |
| `volcano_data.py` | 각 기관 자료 수집 |
| `volcano_official_collectors.py` | PVMBG, KVERT, PHIVOLCS 수집 |
| `volcano_alert_registry.py` | 경보 이력 저장(SQLite)과 화산 이름 매칭 |
| `source_cache.py` | 수집 결과 캐시 |
| `data_loader.py`, `plot_utils.py`, `seismic_stations.py` | `home.py`가 불러오는 모듈(현재 Home 화면에서는 거의 쓰지 않음) |
| `volcano_master_all.xlsx` | 화산 목록(좌표, 번호) |
| `docs/` | Home 기능 명세와 첫 화면 이미지 |

## 원본과 다른 점

- `app.py`: Home에 필요 없는 부분(다른 페이지용 수집·그래프 코드)을 뺐고 기본값을 `LAVA_PAGES=Home`으로 했습니다.
- `volcano_data.py`: 프로젝트 폴더가 `D:\...`로 고정되어 있던 한 줄을 "이 파일이 있는 폴더"로 바꿨습니다.
- `db_config.py`: 실제 접속 정보를 자리표시 값으로 바꿨습니다.
- `pages/home.py` 등 나머지는 원본 그대로입니다.
