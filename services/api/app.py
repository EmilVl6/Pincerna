from flask import Flask, jsonify, request
import jwt
import datetime
import logging
import psutil
import os
import smtplib
from email.message import EmailMessage
import time
import json
import urllib.request
import urllib.parse
import secrets
import hashlib
import base64

app = Flask(__name__)
SECRET = "bartendershandbook"


EMAIL_CODES = {}

OAUTH_STORE = {}
OAUTH_STATE_FILE = os.path.join(os.path.dirname(__file__), 'oauth_state.json')

def _load_oauth_store():
	global OAUTH_STORE
	try:
		if os.path.exists(OAUTH_STATE_FILE):
			with open(OAUTH_STATE_FILE, 'r', encoding='utf-8') as f:
				OAUTH_STORE = json.load(f)
		else:
			OAUTH_STORE = {}
	except Exception:
		OAUTH_STORE = {}

def _save_oauth_store():
	try:
		with open(OAUTH_STATE_FILE, 'w', encoding='utf-8') as f:
			json.dump(OAUTH_STORE, f)
	except Exception:
		logging.exception('failed to save oauth state')


_load_oauth_store()

logging.basicConfig(filename="api.log", level=logging.INFO)

@app.route("/login", methods=["POST"])
def login():
	token = jwt.encode({
		"user": "admin",
		"exp": datetime.datetime.utcnow() + datetime.timedelta(minutes=30)
	}, SECRET, algorithm="HS256")
	return jsonify(token=token)


def send_smtp_mail(to_addr: str, subject: str, body: str):
	"""Send mail using configured SMTP. Configuration via env vars:
	SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
	"""
	host = os.environ.get('SMTP_HOST')
	port = int(os.environ.get('SMTP_PORT', '0') or 0)
	user = os.environ.get('SMTP_USER')
	pwd = os.environ.get('SMTP_PASS')
	mail_from = os.environ.get('SMTP_FROM') or f'no-reply@{os.environ.get("DOMAIN","emilvinod.com")}'
	if not host or port == 0:
		raise RuntimeError('SMTP not configured')
	msg = EmailMessage()
	msg['Subject'] = subject
	msg['From'] = mail_from
	msg['To'] = to_addr
	msg.set_content(body)
	
	if port == 465:
		with smtplib.SMTP_SSL(host, port) as s:
			if user and pwd:
				s.login(user, pwd)
			s.send_message(msg)
	else:
		with smtplib.SMTP(host, port, timeout=10) as s:
			s.ehlo()
			try:
				s.starttls()
				s.ehlo()
			except Exception:
				pass
			if user and pwd:
				s.login(user, pwd)
			s.send_message(msg)


@app.route('/send_code', methods=['POST'])
def send_code():
	data = request.get_json() or {}
	email = (data.get('email') or '').strip().lower()
	
	if email != 'emilvinod@gmail.com':
		return jsonify(error='unknown_account'), 400
	
	code = str(int(100000 + (int(time.time()*1000) % 900000)))
	expires = int(time.time()) + 10*60
	EMAIL_CODES[email] = {'code': code, 'expires': expires}
	
	try:
		subject = 'Pincerna sign-in code'
		body = f'Your Pincerna sign-in code is: {code}\n\nThis code expires in 10 minutes.'
		send_smtp_mail(email, subject, body)
		return jsonify(status='sent')
	except Exception as e:
		
		logging.exception('send_code failed')
		return jsonify(error='send_failed', detail=str(e)), 500


@app.route('/verify_code', methods=['POST'])
def verify_code():
	data = request.get_json() or {}
	email = (data.get('email') or '').strip().lower()
	code = (data.get('code') or '').strip()
	stored = EMAIL_CODES.get(email)
	if not stored:
		return jsonify(error='no_code'), 400
	if int(time.time()) > stored.get('expires', 0):
		del EMAIL_CODES[email]
		return jsonify(error='expired'), 400
	if code != stored.get('code'):
		return jsonify(error='invalid'), 400
	
	token = jwt.encode({
		'user': email,
		'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=12)
	}, SECRET, algorithm='HS256')
	
	try: del EMAIL_CODES[email]
	except: pass
	return jsonify(token=token)


@app.route('/cloud/api/send_code', methods=['POST'])
def send_code_alias():
	return send_code()

@app.route('/cloud/api/verify_code', methods=['POST'])
def verify_code_alias():
	return verify_code()

@app.route('/cloud/api/verify_google', methods=['POST'])
def verify_google_alias():
	return verify_google()

@app.route('/cloud/api/oauth/start')
def oauth_start_alias():
	return oauth_start()

@app.route('/cloud/api/oauth/callback')
def oauth_callback_alias():
	return oauth_callback()


@app.route('/verify_turnstile', methods=['POST'])
def verify_turnstile():
	data = request.get_json() or {}
	token = (data.get('token') or data.get('cf_turnstile_response') or '').strip()
	if not token:
		return jsonify(error='missing_token'), 400
	secret = os.environ.get('TURNSTILE_SECRET')
	if not secret:
		return jsonify(error='turnstile_not_configured'), 500
	post_data = urllib.parse.urlencode({'secret': secret, 'response': token}).encode('utf-8')
	try:
		req = urllib.request.Request('https://challenges.cloudflare.com/turnstile/v0/siteverify', data=post_data,
									 headers={'Content-Type': 'application/x-www-form-urlencoded'})
		with urllib.request.urlopen(req, timeout=6) as resp:
			resp_j = json.load(resp)
	except Exception as e:
		logging.exception('turnstile verify failed')
		return jsonify(error='verify_failed', detail=str(e)), 500
	if not resp_j.get('success'):
		return jsonify(error='not_human', detail=resp_j), 400
	return jsonify(success=True, detail=resp_j)


@app.route('/cloud/api/verify_turnstile', methods=['POST'])
def verify_turnstile_alias():
	return verify_turnstile()


@app.route('/config')
def config():
	
	sitekey = os.environ.get('TURNSTILE_SITEKEY', '')
	return jsonify(turnstile_sitekey=sitekey)


@app.route('/cloud/api/config')
def config_alias():
	return config()


@app.route('/verify_google', methods=['POST'])
def verify_google():
	data = request.get_json() or {}
	id_token = (data.get('id_token') or '').strip()
	if not id_token:
		return jsonify(error='missing_token'), 400
	
	try:
		url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': id_token})
		with urllib.request.urlopen(url, timeout=8) as resp:
			payload = json.load(resp)
	except Exception as e:
		logging.exception('google tokeninfo failed')
		return jsonify(error='token_verification_failed', detail=str(e)), 400
	
	email = payload.get('email')
	verified = payload.get('email_verified') in ('true', True, '1')
	if not email or not verified:
		return jsonify(error='email_not_verified'), 400
	
	try:
		base = os.path.dirname(__file__)
		allowed_path = os.path.join(base, 'allowed_users.json')
		with open(allowed_path, 'r', encoding='utf-8') as f:
			allowed = json.load(f)
	except Exception:
		allowed = ['emilvinod@gmail.com']
	if email.lower() not in [e.lower() for e in allowed]:
		return jsonify(error='not_allowed'), 403
	
	token = jwt.encode({
		'user': email,
		'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=12)
	}, SECRET, algorithm='HS256')
	return jsonify(token=token)


def _access_denied_page(message=None):
	"""Return a clean, centered access denied page."""
	text = message or "Sorry, you don't have access"
	return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access Denied</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{height:100%;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}}
body{{display:flex;align-items:center;justify-content:center;background:#000;color:#fff}}
.message{{text-align:center;padding:40px}}
h1{{font-size:1.5rem;font-weight:500;letter-spacing:-0.02em}}
</style>
</head>
<body>
<div class="message">
<h1>{text}</h1>
</div>
</body>
</html>'''


def _make_redirect_uri():
	
	
	return urllib.parse.urljoin(request.host_url, 'cloud/api/oauth/callback')


@app.route('/oauth/start')
def oauth_start():
	
	client_id = os.environ.get('GOOGLE_CLIENT_ID')
	if not client_id:
		return jsonify(error='missing_client_id'), 500
	state = secrets.token_urlsafe(16)
	code_verifier = secrets.token_urlsafe(64)
	
	sha = hashlib.sha256(code_verifier.encode('utf-8')).digest()
	code_challenge = base64.urlsafe_b64encode(sha).rstrip(b'=').decode('ascii')
	
	OAUTH_STORE[state] = {'code_verifier': code_verifier, 'expires': int(time.time()) + 600}
	_save_oauth_store()
	params = {
		'client_id': client_id,
		'response_type': 'code',
		'scope': 'openid email profile',
		'redirect_uri': _make_redirect_uri(),
		'state': state,
		'code_challenge': code_challenge,
		'code_challenge_method': 'S256',
		'access_type': 'offline',
		'prompt': 'select_account'
	}
	auth_url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
	return ('', 302, {'Location': auth_url})


@app.route('/oauth/callback')
def oauth_callback():
	
	error = request.args.get('error')
	error_desc = request.args.get('error_description', '')
	if error:
		if error == 'access_denied':
			return _access_denied_page("Sign in was cancelled"), 200
		return _access_denied_page(f"Authentication failed"), 200
	
	code = request.args.get('code')
	state = request.args.get('state')
	if not code or not state:
		return _access_denied_page("Missing authentication data"), 200
	
	
	_load_oauth_store()
	stored = OAUTH_STORE.get(state)
	if not stored or stored.get('expires',0) < int(time.time()):
		# State expired or not found - show error instead of silent redirect
		return _access_denied_page("Session expired. Please try signing in again."), 200
	
	code_verifier = stored.get('code_verifier')
	
	token_url = 'https://oauth2.googleapis.com/token'
	client_id = os.environ.get('GOOGLE_CLIENT_ID')
	client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
	redirect_uri = _make_redirect_uri()
	post_data = {
		'code': code,
		'client_id': client_id,
		'client_secret': client_secret,
		'redirect_uri': redirect_uri,
		'grant_type': 'authorization_code',
		'code_verifier': code_verifier
	}
	data = urllib.parse.urlencode(post_data).encode('utf-8')
	try:
		req = urllib.request.Request(token_url, data=data, headers={'Content-Type':'application/x-www-form-urlencoded'})
		with urllib.request.urlopen(req, timeout=10) as resp:
			resp_j = json.load(resp)
	except Exception as e:
		logging.exception('token exchange failed')
		return _access_denied_page('Authentication failed'), 200
	id_token = resp_j.get('id_token')
	if not id_token:
		return _access_denied_page('Authentication failed'), 200
	
	try:
		url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': id_token})
		with urllib.request.urlopen(url, timeout=8) as r:
			payload = json.load(r)
	except Exception as e:
		logging.exception('tokeninfo failed')
		return _access_denied_page('Authentication failed'), 200
	email = payload.get('email')
	verified = payload.get('email_verified') in ('true', True, '1')
	if not email or not verified:
		return _access_denied_page('Email not verified'), 200
	
	try:
		base = os.path.dirname(__file__)
		allowed_path = os.path.join(base, 'allowed_users.json')
		with open(allowed_path, 'r', encoding='utf-8') as f:
			allowed = json.load(f)
	except Exception:
		allowed = ['emilvinod@gmail.com']
	if email.lower() not in [e.lower() for e in allowed]:
		return _access_denied_page(), 403
	
	user_name = payload.get('name', '')
	user_given = payload.get('given_name', '')
	user_picture = payload.get('picture', '')
	
	token = jwt.encode({'user': email, 'name': user_name, 'given_name': user_given, 'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=12)}, SECRET, algorithm='HS256')
	
	try:
		del OAUTH_STORE[state]
		_save_oauth_store()
	except:
		pass
	
	user_info = {'email': email, 'name': user_name, 'given_name': user_given, 'picture': user_picture}
	
	# Both values need to be JSON strings for JavaScript
	token_js = json.dumps(token)
	user_js = json.dumps(json.dumps(user_info))  # Double encode: Python dict -> JSON string -> JS string literal
	
	html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<p id="msg">Signing you in...</p>
<script>
try {{
  localStorage.setItem('pincerna_token', {token_js});
  localStorage.setItem('pincerna_user', {user_js});
  document.getElementById('msg').textContent = 'Success! Redirecting...';
  setTimeout(function() {{ window.location.replace('/cloud/index.html'); }}, 100);
}} catch(e) {{
  document.getElementById('msg').textContent = 'Error: ' + e.message;
  console.error('Auth callback error:', e);
}}
</script>
</body></html>"""
	return html

def protected(f):
	def wrapper(*args, **kwargs):
		token = request.headers.get("Authorization")
		if not token:
			return jsonify(error="Missing token"), 401
		try:
			jwt.decode(token, SECRET, algorithms=["HS256"])
		except:
			return jsonify(error="Invalid token"), 401
		return f(*args, **kwargs)
	wrapper.__name__ = f.__name__
	return wrapper

@app.route("/health")
def health():
	return jsonify(status="ok")

@app.route("/data")
@protected
def data():
	return jsonify(message="Local Bartender (CLASSY SERVER) Breathes")

@app.route("/metrics")
def metrics():
	import time
	cpu_percent = psutil.cpu_percent(interval=0.1)
	mem = psutil.virtual_memory()
	disk = psutil.disk_usage('/')
	net = psutil.net_io_counters()
	boot_time = psutil.boot_time()
	uptime_seconds = time.time() - boot_time
	
	
	cpu_temp = None
	try:
		temps = psutil.sensors_temperatures()
		if 'cpu_thermal' in temps:
			cpu_temp = temps['cpu_thermal'][0].current
		elif 'coretemp' in temps:
			cpu_temp = temps['coretemp'][0].current
	except:
		pass
	
	
	try:
		load_avg = [round(x, 2) for x in psutil.getloadavg()]
	except:
		load_avg = [0, 0, 0]
	
	
	try:
		process_count = len(psutil.pids())
	except:
		process_count = 0
	
	return jsonify(
		cpu=round(cpu_percent, 1),
		cpu_count=psutil.cpu_count(),
		cpu_temp=round(cpu_temp, 1) if cpu_temp else None,
		memory=round(mem.percent, 1),
		memory_used=mem.used,
		memory_total=mem.total,
		memory_available=mem.available,
		disk=round(disk.percent, 1),
		disk_used=disk.used,
		disk_total=disk.total,
		disk_free=disk.free,
		net_sent=net.bytes_sent,
		net_recv=net.bytes_recv,
		uptime=int(uptime_seconds),
		load_avg=load_avg,
		process_count=process_count
	)

@app.route("/vpn/stats")
@protected
def vpn_stats():
	"""Get detailed VPN statistics"""
	import subprocess
	try:
		
		result = subprocess.run(['ip', 'link', 'show', 'wg0'], capture_output=True, text=True)
		is_up = result.returncode == 0 and 'UP' in result.stdout
		
		if not is_up:
			return jsonify(connected=False, peers=[], transfer_rx=0, transfer_tx=0)
		
		
		wg_result = subprocess.run(['sudo', 'wg', 'show', 'wg0'], capture_output=True, text=True)
		if wg_result.returncode != 0:
			return jsonify(connected=True, peers=[], transfer_rx=0, transfer_tx=0)
		
		
		lines = wg_result.stdout.strip().split('\n')
		peers = []
		current_peer = None
		total_rx = 0
		total_tx = 0
		
		for line in lines:
			line = line.strip()
			if line.startswith('peer:'):
				if current_peer:
					peers.append(current_peer)
				current_peer = {'public_key': line.split(':')[1].strip()[:16] + '...'}
			elif current_peer:
				if 'endpoint:' in line:
					current_peer['endpoint'] = line.split(':')[1].strip() + ':' + line.split(':')[2].strip() if ':' in line.split(':')[1] else line.split(':')[1].strip()
				elif 'latest handshake:' in line:
					current_peer['last_handshake'] = line.split(':', 1)[1].strip()
				elif 'transfer:' in line:
					parts = line.split(':')[1].strip().split(',')
					if len(parts) >= 2:
						rx_str = parts[0].strip()
						tx_str = parts[1].strip()
						current_peer['transfer'] = f"{rx_str} / {tx_str}"
						
						try:
							rx_val = float(rx_str.split()[0])
							tx_val = float(tx_str.split()[0])
							rx_unit = rx_str.split()[1] if len(rx_str.split()) > 1 else 'B'
							tx_unit = tx_str.split()[1] if len(tx_str.split()) > 1 else 'B'
							multipliers = {'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3}
							total_rx += rx_val * multipliers.get(rx_unit, 1)
							total_tx += tx_val * multipliers.get(tx_unit, 1)
						except:
							pass
				elif 'allowed ips:' in line:
					current_peer['allowed_ips'] = line.split(':')[1].strip()
		
		if current_peer:
			peers.append(current_peer)
		
		return jsonify(
			connected=True,
			peers=peers,
			peer_count=len(peers),
			transfer_rx=int(total_rx),
			transfer_tx=int(total_tx)
		)
	except Exception as e:
		return jsonify(connected=False, error=str(e))

@app.route("/restart", methods=["POST"])
@protected
def restart_service():
	
	return jsonify(message="Restart command received", status="ok")

def _get_files_base():
	return os.environ.get('FILES_ROOT', '/home')

def _safe_path(path):
	"""Ensure path stays within FILES_ROOT"""
	base_dir = _get_files_base()
	full_path = os.path.normpath(os.path.join(base_dir, path.lstrip('/')))
	if not full_path.startswith(base_dir):
		return None
	return full_path

@app.route("/files")
@protected
def list_files():
	path = request.args.get('path', '/')
	full_path = _safe_path(path)
	if not full_path:
		return jsonify(error='Invalid path'), 400
	try:
		items = []
		if os.path.isdir(full_path):
			for name in os.listdir(full_path):
				try:
					item_path = os.path.join(full_path, name)
					rel_path = os.path.join(path, name)
					stat = os.stat(item_path)
					size = stat.st_size if not os.path.isdir(item_path) else None
					
					if size is not None:
						if size > 1024*1024*1024:
							size_str = f"{size/(1024*1024*1024):.1f} GB"
						elif size > 1024*1024:
							size_str = f"{size/(1024*1024):.1f} MB"
						elif size > 1024:
							size_str = f"{size/1024:.1f} KB"
						else:
							size_str = f"{size} B"
					else:
						size_str = ""
					items.append({
						'name': name,
						'path': rel_path,
						'is_dir': os.path.isdir(item_path),
						'size': size_str,
						'mtime': datetime.datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M')
					})
				except (PermissionError, OSError):
					pass
		
		items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
		return jsonify(files=items, path=path)
	except Exception as e:
		return jsonify(error=str(e)), 500

@app.route("/files/download")
@protected
def download_file():
	path = request.args.get('path', '')
	full_path = _safe_path(path)
	if not full_path or not os.path.isfile(full_path):
		return jsonify(error='File not found'), 404
	from flask import send_file
	return send_file(full_path, as_attachment=True)

@app.route("/files/upload", methods=["POST"])
@protected
def upload_file():
	if 'file' not in request.files:
		return jsonify(error='No file provided'), 400
	file = request.files['file']
	if file.filename == '':
		return jsonify(error='No file selected'), 400
	path = request.form.get('path', '/')
	full_path = _safe_path(path)
	if not full_path:
		return jsonify(error='Invalid path'), 400
	if not os.path.isdir(full_path):
		os.makedirs(full_path, exist_ok=True)
	
	from werkzeug.utils import secure_filename
	filename = secure_filename(file.filename)
	dest = os.path.join(full_path, filename)
	file.save(dest)
	return jsonify(success=True, filename=filename)

@app.route("/files", methods=["DELETE"])
@protected
def delete_file():
	path = request.args.get('path', '')
	full_path = _safe_path(path)
	if not full_path:
		return jsonify(error='Invalid path'), 400
	if not os.path.exists(full_path):
		return jsonify(error='File not found'), 404
	try:
		if os.path.isdir(full_path):
			import shutil
			shutil.rmtree(full_path)
		else:
			os.remove(full_path)
		return jsonify(success=True)
	except Exception as e:
		return jsonify(error=str(e)), 500

@app.route("/files/rename", methods=["POST"])
@protected
def rename_file_endpoint():
	data = request.get_json() or {}
	path = data.get('path', '')
	new_name = data.get('new_name', '')
	
	if not path or not new_name:
		return jsonify(error='Missing path or new_name'), 400
	
	full_path = _safe_path(path)
	if not full_path or not os.path.exists(full_path):
		return jsonify(error='File not found'), 404
	
	
	from werkzeug.utils import secure_filename
	safe_name = secure_filename(new_name)
	if not safe_name:
		return jsonify(error='Invalid filename'), 400
	
	
	parent_dir = os.path.dirname(full_path)
	new_full_path = os.path.join(parent_dir, safe_name)
	
	
	if os.path.exists(new_full_path):
		return jsonify(error='A file with that name already exists'), 400
	
	try:
		os.rename(full_path, new_full_path)
		return jsonify(success=True, new_path=new_full_path)
	except Exception as e:
		return jsonify(error=str(e)), 500

@app.route("/files/mkdir", methods=["POST"])
@protected
def make_directory():
	data = request.get_json() or {}
	path = data.get('path', '/')
	name = data.get('name', '')
	
	if not name:
		return jsonify(error='Missing folder name'), 400
	
	
	from werkzeug.utils import secure_filename
	safe_name = secure_filename(name)
	if not safe_name:
		return jsonify(error='Invalid folder name'), 400
	
	full_path = _safe_path(path)
	if not full_path:
		return jsonify(error='Invalid path'), 400
	
	new_folder = os.path.join(full_path, safe_name)
	
	
	base_dir = _get_files_base()
	if not new_folder.startswith(base_dir):
		return jsonify(error='Invalid path'), 400
	
	if os.path.exists(new_folder):
		return jsonify(error='Folder already exists'), 400
	
	try:
		os.makedirs(new_folder)
		return jsonify(success=True, path=new_folder)
	except Exception as e:
		return jsonify(error=str(e)), 500

@app.route("/files/move", methods=["POST"])
@protected
def move_file_endpoint():
	data = request.get_json() or {}
	src_path = data.get('path', '')
	dest_path = data.get('destination', '')
	
	if not src_path or not dest_path:
		return jsonify(error='Missing path or destination'), 400
	
	full_src = _safe_path(src_path)
	full_dest = _safe_path(dest_path)
	
	if not full_src or not os.path.exists(full_src):
		return jsonify(error='Source not found'), 404
	
	if not full_dest:
		return jsonify(error='Invalid destination'), 400
	
	
	if os.path.isdir(full_dest):
		filename = os.path.basename(full_src)
		full_dest = os.path.join(full_dest, filename)
	
	
	if os.path.exists(full_dest):
		return jsonify(error='Destination already exists'), 400
	
	try:
		import shutil
		shutil.move(full_src, full_dest)
		return jsonify(success=True, new_path=full_dest)
	except Exception as e:
		return jsonify(error=str(e)), 500

@app.route("/vpn/status")
@protected
def vpn_status():
	
	try:
		import subprocess
		result = subprocess.run(['ip', 'link', 'show', 'wg0'], capture_output=True, text=True)
		connected = result.returncode == 0 and 'UP' in result.stdout
		return jsonify(connected=connected)
	except:
		return jsonify(connected=False)

@app.route("/vpn/toggle", methods=["POST"])
@protected
def vpn_toggle():
	try:
		import subprocess
		
		result = subprocess.run(['ip', 'link', 'show', 'wg0'], capture_output=True, text=True)
		is_up = result.returncode == 0 and 'UP' in result.stdout
		if is_up:
			subprocess.run(['sudo', 'wg-quick', 'down', 'wg0'], capture_output=True)
			return jsonify(connected=False, message='VPN disconnected')
		else:
			subprocess.run(['sudo', 'wg-quick', 'up', 'wg0'], capture_output=True)
			return jsonify(connected=True, message='VPN connected')
	except Exception as e:
		return jsonify(error=str(e)), 500

if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5002)
