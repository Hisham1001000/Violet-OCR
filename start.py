"""
start.py — kills anything on 8001/3000, then starts both servers.
Run with: python start.py
"""
import subprocess, time, sys, os

def kill_port(port):
    r = subprocess.run(['netstat', '-ano'], capture_output=True, text=True)
    pids = set()
    for line in r.stdout.splitlines():
        if f':{port} ' in line and 'LISTEN' in line:
            pid = line.strip().split()[-1]
            if pid.isdigit():
                pids.add(pid)
    for pid in pids:
        subprocess.run(['taskkill', '/F', '/PID', pid], capture_output=True)
        print(f'  killed PID {pid} on port {port}')

os.makedirs('.tmp', exist_ok=True)

print('Clearing ports 8001 and 3000...')
kill_port(8001)
kill_port(3000)
time.sleep(2)

print('Starting pipeline server (port 8001)...')
_env = os.environ.copy()
_env['PYTHONIOENCODING'] = 'utf-8'
_env['PYTHONDONTWRITEBYTECODE'] = '1'  # always read source, never use stale .pyc
subprocess.Popen(
    [sys.executable, '-m', 'uvicorn', 'execution.local_server:app',
     '--host', '0.0.0.0', '--port', '8001', '--reload'],
    stdout=open('.tmp/server.log', 'w', encoding='utf-8'),
    stderr=subprocess.STDOUT,
    cwd=os.getcwd(),
    env=_env,
)

print('Starting frontend (port 3000)...')
subprocess.Popen(
    ['npm', 'run', 'dev'],
    stdout=open('.tmp/frontend.log', 'w'),
    stderr=subprocess.STDOUT,
    cwd=os.path.join(os.getcwd(), 'frontend'),
    shell=True,
)

print('Waiting for servers to start...')

import urllib.request

def wait_for(label, url, timeout=60, interval=3):
    """Poll url until it responds or timeout (seconds) is reached."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=5)
            print(f'  {label} OK up')
            return
        except Exception as e:
            status = str(e)
            # Any HTTP response (including redirects/404/405) means server is up
            if any(code in status for code in ['307', '308', '301', '302', '200', '404', '405']):
                print(f'  {label} OK up')
                return
        time.sleep(interval)
    print(f'  {label} FAILED - check .tmp/server.log or .tmp/frontend.log')

wait_for('Pipeline API', 'http://127.0.0.1:8001/', timeout=30)
wait_for('Frontend',     'http://127.0.0.1:3000/', timeout=60)

print('\nDone. Open http://localhost:3000')
