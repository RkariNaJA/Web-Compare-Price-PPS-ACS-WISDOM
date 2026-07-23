# 3-Way Validator — Frontend

React + TypeScript + Vite port of `index.html`. Talks to the Flask backend in `../sql_backend.py` for ACS and Costsheet data; PPS files are uploaded in the browser.

## Architecture

```
DashBoard/
├── sql_backend.py        Flask · port 5001 · SQL Server bridge
│                         GET /get_file_a_data       → dbo.ACS
│                         GET /get_costsheet_data    → dbo.VIEW_COSTSHEET_WISDOM
└── frontend/
    ├── src/
    │   ├── lib/          domain logic (pure, no React)
    │   │   ├── api.ts            backend fetchers
    │   │   ├── constants.ts      KEY_PAIRS, sizes, file colors
    │   │   ├── normalize.ts      size + join-key normalisation
    │   │   ├── costsheet.ts      buildIndex + lookup with MAX(First Input Date)
    │   │   ├── comparison.ts     runComparison (3-way validation)
    │   │   ├── csv.ts            CSV export
    │   │   └── types.ts
    │   ├── components/   UI
    │   ├── hooks/        useToast
    │   └── styles/       tokens.css + global.css
    └── .env              VITE_BACKEND_URL=http://localhost:5001
```

## Running

### 1. Start the backend (in another shell)

```powershell
cd "DashBoard"
python -m pip install flask flask-cors pyodbc
python sql_backend.py
# serves http://localhost:5001
```

The backend talks to `<SQL_HOST>\<SQL_HOST>` / `<DATABASE>` using Windows auth (`Trusted_Connection=yes`). CORS is enabled for any origin via `flask_cors`.

### 2. Start the frontend

```powershell
cd "DashBoard\frontend"
npm install
npm run dev
# opens http://localhost:5173
```

The backend URL is read from `VITE_BACKEND_URL` in `.env` (default `http://localhost:5001`).

## Validation flow

1. **Load ACS from DB** (File A) → fetches `dbo.ACS`, expands underscore-joined `ColorwayCode` rows, and appends a virtual `EXTRACTED_SIZE` from CBDID.
2. **Upload PPS files** (File B) — up to 4 `.xlsx`/`.xls`/`.csv` files. Only the 6 strict columns (`SEASON_YEAR`, `STYLE`, `COLOR`, `FTYCODE`, `SIZE_DATA`, `LOCAL_QUOTE_AMOUNT`) are kept.
3. **(Optional) Load Costsheet from DB** (File C) → fetches `dbo.VIEW_COSTSHEET_WISDOM`. Group sizes `ALL_REG_SIZE` / `ALL_EXTEND_SIZE` are normalised to the `_RB` suffix used everywhere else.
4. **Validate** → 3-way match. `ACS Match?` is green only when `LOCAL_QUOTE_AMOUNT == ACS FOB == Costsheet Final FOB`. If Costsheet is missing the column shows `—`; the 3-way falls back to 2-way against ACS.

## Build

```powershell
npm run build
npm run preview
```

`npm run build` runs `tsc -b` first; any TypeScript error stops the build.

## Notes

- The Costsheet header lookup is tolerant: `Final FOB`, `FinalFOB`, `Final_FOB`, etc. all resolve. Aliases live in `src/lib/constants.ts` → `C_KEY_ALIASES`.
- The output table renders at most 2,000 rows; the full set goes through CSV export.
