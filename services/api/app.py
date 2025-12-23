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
SECRET = os.environ.get('JWT_SECRET', 'bartendershandbook-change-in-production')


EMAIL_CODES = {}

OAUTH_STORE = {}
OAUTH_STATE_FILE = '/tmp/pincerna_oauth_state.json'

def _load_oauth_store():
	global OAUTH_STORE
	try:
		if os.path.exists(OAUTH_STATE_FILE):
			with open(OAUTH_STATE_FILE, 'r', encoding='utf-8') as f:
				OAUTH_STORE = json.load(f)
		else:
			OAUTH_STORE = {}
	except Exception as e:
		logging.warning(f'Failed to load oauth state: {e}')
		OAUTH_STORE = {}

def _save_oauth_store():
	try:
		with open(OAUTH_STATE_FILE, 'w', encoding='utf-8') as f:
			json.dump(OAUTH_STORE, f)
	except Exception as e:
		logging.exception(f'failed to save oauth state to {OAUTH_STATE_FILE}: {e}')


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
	
	# Load allowed users
	try:
		base = os.path.dirname(__file__)
		allowed_path = os.path.join(base, 'allowed_users.json')
		with open(allowed_path, 'r', encoding='utf-8') as f:
			allowed = [e.lower() for e in json.load(f)]
	except Exception:
		allowed = ['emilvinod@gmail.com']
	
	if email not in allowed:
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
	
	token_js = json.dumps(token)
	user_js = json.dumps(json.dumps(user_info))
	
	html = f"""<!doctype html><html><head><meta charset="utf-8"></head><body><script>
localStorage.setItem('pincerna_token',{token_js});
localStorage.setItem('pincerna_user',{user_js});
location.replace('/cloud/index.html');
</script></body></html>"""
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
def download_file():
	"""Download a file - supports both Authorization header and token query param"""
	# Check authorization - first try header, then query param
	token = request.headers.get('Authorization') or request.args.get('token')
	if not token:
		return jsonify(error='Missing token'), 401
	try:
		jwt.decode(token, SECRET, algorithms=['HS256'])
	except:
		return jsonify(error='Invalid token'), 401
	
	path = request.args.get('path', '')
	full_path = _safe_path(path)
	if not full_path or not os.path.isfile(full_path):
		return jsonify(error='File not found'), 404
	
	from flask import send_file
	try:
		# Get the filename for download
		filename = os.path.basename(full_path)
		return send_file(
			full_path,
			as_attachment=True,
			download_name=filename
		)
	except Exception as e:
		logging.exception('Download failed')
		return jsonify(error=str(e)), 500

@app.route("/files/preview")
def preview_file():
	"""Preview a file inline - for images, PDFs, etc"""
	token = request.headers.get('Authorization') or request.args.get('token')
	if not token:
		return jsonify(error='Missing token'), 401
	try:
		jwt.decode(token, SECRET, algorithms=['HS256'])
	except:
		return jsonify(error='Invalid token'), 401
	
	path = request.args.get('path', '')
	full_path = _safe_path(path)
	if not full_path or not os.path.isfile(full_path):
		return jsonify(error='File not found'), 404
	
	from flask import send_file
	import mimetypes
	try:
		mimetype = mimetypes.guess_type(full_path)[0] or 'application/octet-stream'
		return send_file(full_path, mimetype=mimetype)
	except Exception as e:
		logging.exception('Preview failed')
		return jsonify(error=str(e)), 500

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
	"""Get Tailscale VPN connection status"""
	try:
		import subprocess
		# Check if tailscale is installed and running
		result = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True)
		if result.returncode != 0:
			return jsonify(connected=False, configured=False, error='Tailscale not running')
		
		status = json.loads(result.stdout)
		is_connected = status.get('BackendState') == 'Running'
		self_ip = status.get('TailscaleIPs', [''])[0] if status.get('TailscaleIPs') else ''
		
		# Get peer count
		peers = status.get('Peer', {})
		online_peers = sum(1 for p in peers.values() if p.get('Online', False))
		
		return jsonify(
			connected=is_connected,
			configured=True,
			ip=self_ip,
			peer_count=online_peers,
			backend_state=status.get('BackendState', 'Unknown')
		)
	except FileNotFoundError:
		return jsonify(connected=False, configured=False, error='Tailscale not installed')
	except Exception as e:
		return jsonify(connected=False, error=str(e))

@app.route("/vpn/peers")
@protected
def vpn_peers():
	"""Get list of Tailscale peers (devices on your network)"""
	try:
		import subprocess
		result = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True)
		if result.returncode != 0:
			return jsonify(peers=[], error='Tailscale not running')
		
		status = json.loads(result.stdout)
		peers_data = status.get('Peer', {})
		
		peers = []
		for key, peer in peers_data.items():
			peers.append({
				'name': peer.get('HostName', 'Unknown'),
				'ip': peer.get('TailscaleIPs', [''])[0] if peer.get('TailscaleIPs') else '',
				'online': peer.get('Online', False),
				'os': peer.get('OS', ''),
				'last_seen': peer.get('LastSeen', '')
			})
		
		return jsonify(peers=peers)
	except Exception as e:
		return jsonify(peers=[], error=str(e))

@app.route("/vpn/toggle", methods=["POST"])
@protected
def vpn_toggle():
	"""Tailscale is always-on, this just returns current status"""
	try:
		import subprocess
		result = subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True)
		if result.returncode != 0:
			return jsonify(error='Tailscale not running. Run: sudo tailscale up'), 400
		
		status = json.loads(result.stdout)
		is_connected = status.get('BackendState') == 'Running'
		
		return jsonify(
			connected=is_connected,
			message='Tailscale is always-on. Install the Tailscale app on your device and sign in with Google to connect.'
		)
	except FileNotFoundError:
		return jsonify(error='Tailscale not installed'), 400
	except Exception as e:
		logging.exception('VPN status check failed')
		return jsonify(error=str(e)), 500

# ==================== NETWORK SCANNING ====================

def get_local_network_range():
	"""Get the local network CIDR range"""
	import subprocess
	try:
		# Get default gateway interface IP
		result = subprocess.run(['ip', 'route', 'get', '1.1.1.1'], capture_output=True, text=True)
		if result.returncode == 0:
			# Parse output like: "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.100"
			parts = result.stdout.split()
			for i, part in enumerate(parts):
				if part == 'src' and i + 1 < len(parts):
					local_ip = parts[i + 1]
					# Assume /24 network
					prefix = '.'.join(local_ip.split('.')[:3])
					return f"{prefix}.0/24", local_ip
	except:
		pass
	return "192.168.1.0/24", "192.168.1.1"

@app.route("/network/scan")
@protected
def network_scan():
	"""Scan the local network for devices"""
	import subprocess
	import socket
	
	try:
		network_range, server_ip = get_local_network_range()
		devices = []
		
		# Try nmap first (fast and accurate)
		try:
			result = subprocess.run(
				['nmap', '-sn', '-oG', '-', network_range],
				capture_output=True, text=True, timeout=30
			)
			if result.returncode == 0:
				for line in result.stdout.split('\n'):
					if 'Host:' in line and 'Status: Up' in line:
						parts = line.split()
						ip = parts[1]
						hostname = ''
						if '(' in line and ')' in line:
							hostname = line.split('(')[1].split(')')[0]
						
						device = {
							'ip': ip,
							'hostname': hostname or get_hostname(ip),
							'online': True,
							'is_server': ip == server_ip,
							'services': []
						}
						devices.append(device)
		except (FileNotFoundError, subprocess.TimeoutExpired):
			# Fallback: use ARP table
			result = subprocess.run(['ip', 'neigh'], capture_output=True, text=True)
			if result.returncode == 0:
				for line in result.stdout.split('\n'):
					parts = line.split()
					if len(parts) >= 4 and parts[0].count('.') == 3:
						ip = parts[0]
						state = parts[-1] if parts else 'STALE'
						if state in ['REACHABLE', 'STALE', 'DELAY']:
							device = {
								'ip': ip,
								'hostname': get_hostname(ip),
								'online': state == 'REACHABLE',
								'is_server': ip == server_ip,
								'mac': parts[4] if len(parts) > 4 and ':' in parts[4] else '',
								'services': []
							}
							devices.append(device)
		
		# Add the server itself
		if not any(d['ip'] == server_ip for d in devices):
			devices.insert(0, {
				'ip': server_ip,
				'hostname': socket.gethostname(),
				'online': True,
				'is_server': True,
				'services': [{'port': 80, 'name': 'http'}, {'port': 443, 'name': 'https'}]
			})
		
		# Sort: server first, then by IP
		devices.sort(key=lambda d: (not d.get('is_server'), tuple(map(int, d['ip'].split('.')))))
		
		return jsonify(
			devices=devices,
			network=network_range,
			server_ip=server_ip,
			scanned_at=datetime.datetime.now().isoformat()
		)
	except Exception as e:
		logging.exception('Network scan failed')
		return jsonify(error=str(e), devices=[]), 500

def get_hostname(ip):
	"""Try to resolve hostname from IP"""
	import socket
	try:
		hostname = socket.gethostbyaddr(ip)[0]
		return hostname.split('.')[0]  # Return short hostname
	except:
		return ''

@app.route("/network/device/<ip>/ports")
@protected
def scan_device_ports(ip):
	"""Scan common ports on a device"""
	import socket
	
	# Validate IP format
	try:
		parts = ip.split('.')
		if len(parts) != 4 or not all(0 <= int(p) <= 255 for p in parts):
			return jsonify(error='Invalid IP address'), 400
		
		# Only allow scanning private network IPs (security measure)
		first_octet = int(parts[0])
		second_octet = int(parts[1])
		is_private = (
			first_octet == 10 or  # 10.0.0.0/8
			(first_octet == 172 and 16 <= second_octet <= 31) or  # 172.16.0.0/12
			(first_octet == 192 and second_octet == 168) or  # 192.168.0.0/16
			first_octet == 127  # localhost
		)
		if not is_private:
			return jsonify(error='Can only scan private network addresses'), 400
	except:
		return jsonify(error='Invalid IP address'), 400
	
	common_ports = [
		(22, 'SSH'),
		(80, 'HTTP'),
		(443, 'HTTPS'),
		(445, 'SMB'),
		(548, 'AFP'),
		(3389, 'RDP'),
		(5000, 'Synology'),
		(5001, 'Synology SSL'),
		(8080, 'HTTP Alt'),
		(8443, 'HTTPS Alt'),
		(9000, 'Portainer'),
		(32400, 'Plex'),
	]
	
	open_ports = []
	for port, name in common_ports:
		try:
			sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
			sock.settimeout(0.5)
			result = sock.connect_ex((ip, port))
			if result == 0:
				open_ports.append({'port': port, 'name': name})
			sock.close()
		except:
			pass
	
	return jsonify(ip=ip, ports=open_ports)

@app.route("/network/info")
@protected
def network_info():
	"""Get server's network information"""
	import subprocess
	try:
		network_range, server_ip = get_local_network_range()
		
		# Get gateway
		gateway = ''
		try:
			result = subprocess.run(['ip', 'route'], capture_output=True, text=True)
			for line in result.stdout.split('\n'):
				if line.startswith('default'):
					gateway = line.split()[2]
					break
		except:
			pass
		
		# Get hostname
		import socket
		hostname = socket.gethostname()
		
		return jsonify(
			server_ip=server_ip,
			gateway=gateway,
			network=network_range,
			hostname=hostname
		)
	except Exception as e:
		return jsonify(error=str(e)), 500

# Cloud API prefix aliases for all endpoints
@app.route("/cloud/api/health")
def health_alias():
	return health()

@app.route("/cloud/api/metrics")
def metrics_alias():
	return metrics()

@app.route("/cloud/api/vpn/status")
def vpn_status_alias():
	return vpn_status()

@app.route("/cloud/api/vpn/peers")
def vpn_peers_alias():
	return vpn_peers()

@app.route("/cloud/api/vpn/toggle", methods=["POST"])
def vpn_toggle_alias():
	return vpn_toggle()

@app.route("/cloud/api/network/scan")
def network_scan_alias():
	return network_scan()

@app.route("/cloud/api/network/device/<ip>/ports")
def scan_device_ports_alias(ip):
	return scan_device_ports(ip)

@app.route("/cloud/api/network/info")
def network_info_alias():
	return network_info()

@app.route("/cloud/api/files")
def files_list_alias():
	return list_files()

@app.route("/cloud/api/files", methods=["DELETE"])
def files_delete_alias():
	return delete_file()

@app.route("/cloud/api/files/download")
def files_download_alias():
	return download_file()

@app.route("/cloud/api/files/preview")
def files_preview_alias():
	return preview_file()

@app.route("/cloud/api/files/upload", methods=["POST"])
def files_upload_alias():
	return upload_file()

@app.route("/cloud/api/files/rename", methods=["POST"])
def files_rename_alias():
	return rename_file_endpoint()

@app.route("/cloud/api/files/mkdir", methods=["POST"])
def files_mkdir_alias():
	return make_directory()

@app.route("/cloud/api/files/move", methods=["POST"])
def files_move_alias():
	return move_file_endpoint()

@app.route("/cloud/api/restart", methods=["POST"])
def restart_alias():
	return restart_service()

if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5002)
