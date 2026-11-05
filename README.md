# L.A.V.A. Home

Home 화면(세계 지도, VAAC 말풍선, Volcano & Alerts 패널, 미니맵)의 두 가지 버전입니다.

| 폴더 | 내용 |
|---|---|
| [`original_python/`](original_python/) | **변환 전 원본**. Python(Dash) 앱, 기능 명세(`docs/`), 수집 결과 스냅샷(`cache/`), 화산 목록(`volcano_master_all.xlsx`) |
| [`web/`](web/) | **변환 후**. Next.js 16 + React 19 + react-leaflet. Vercel에 배포합니다(Root Directory = `web`) |

## 원본 Python 앱 실행

```bash
cd original_python
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

자세한 내용은 [`original_python/README.md`](original_python/README.md)를 보세요.

## 새 버전 실행·배포

[`web/README.md`](web/README.md)에 실행 방법, 환경 변수, Vercel 배포, Python과의 파일 대응표가 있습니다.

## 두 폴더의 관계

`original_python/`은 변환의 **기준**입니다. `web/`의 테스트가 이 폴더를 읽어서 새 버전이 원본과 같은 판정을 내리는지 확인합니다.

- `web/scripts/gen-python-reference.py` — 원본의 판정 함수(`pages/home.py`)를 그대로 실행하고, 스냅샷(`cache/`)을 입력으로 기준값을 만듭니다.
- `web/scripts/build-master.mjs` — 원본의 `volcano_master_all.xlsx`를 JSON으로 변환합니다.
- `web/scripts/smoke-sources.ts` — 원본의 `cache/latest_sources.json`과 라이브 수집 결과를 비교합니다.

그래서 원본 폴더 안의 파일은 수정하지 않는 편이 좋습니다. 옮기거나 이름을 바꾸면 위 스크립트의 경로도 함께 고쳐야 합니다.
