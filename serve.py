"""Production entry point — serves the Flask app under waitress.

Use this instead of `python sql_backend.py` on any shared/always-on host: the
Flask built-in server is single-threaded and dev-only. Importing sql_backend
runs its load_dotenv() + init_db() calls, so config and SQLite tables are ready
before the first request.

    python serve.py

Env overrides: SERVE_HOST, SERVE_PORT, SERVE_THREADS.
Bind to 127.0.0.1 once a reverse proxy (IIS/Caddy) fronts the app, so Flask is
never exposed to the LAN directly. See README §10.4 and the go-live checklist.
"""
import os

from waitress import serve

from sql_backend import app

if __name__ == '__main__':
    # `or` not getenv's default: a set-but-empty var in .env (SERVE_HOST=) yields '',
    # and waitress reads host='' as "enumerate this machine's addresses" — which picks up
    # the WSL adapter and link-local IPv6. Treat empty as unset.
    host = os.getenv('SERVE_HOST') or '0.0.0.0'
    port = int(os.getenv('SERVE_PORT') or '5001')
    threads = int(os.getenv('SERVE_THREADS') or '8')
    print(f'* waitress serving on http://{host}:{port} ({threads} threads)', flush=True)
    serve(app, host=host, port=port, threads=threads)
