from flask import Flask, jsonify, request, send_file, Response
import jwt
import datetime
import logging
import psutil
import os
import time
import json
import urllib.request
import urllib.parse
import secrets
import hashlib
import base64
import threading
import shutil
import subprocess
import tempfile
from collections import deque

app = Flask(__name__)
SECRET = os.environ.get('JWT_SECRET', 'bartendershandbook-change-in-production')


OAUTH_STORE = {}
OAUTH_STATE_FILE = '/tmp/pincerna_oauth_state.json'

# In-memory helpers
RECENT_BACKUPS = deque(maxlen=50)
VIDEO_INDEX = {}
VIDEO_INDEX_LOCK = threading.Lock()

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
	"""Persist the in-memory OAUTH_STORE to disk."""
	try:
		with open(OAUTH_STATE_FILE, 'w', encoding='utf-8') as f:
			json.dump(OAUTH_STORE, f)
	except Exception as e:
		logging.exception(f'failed to save oauth state to {OAUTH_STATE_FILE}: {e}')


def _thumbs_dir():
	thumbs = _get_files_base() + "/.thumbs"
	try:
		os.makedirs(thumbs, exist_ok=True)
	except Exception:
		pass
	return thumbs


def _ensure_thumbnail(full):
	"""Ensure a thumbnail exists for `full` and return the thumbnail path on disk."""
	thumbs = _thumbs_dir()
	h = hashlib.md5(full.encode('utf-8')).hexdigest()
	thumb_path = os.path.join(thumbs, f"{h}.jpg")
	if os.path.exists(thumb_path):
		return thumb_path
	try:
		cmd = ['ffmpeg', '-y', '-ss', '5', '-i', full, '-frames:v', '1', '-q:v', '2', thumb_path]
		subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
		return thumb_path
	except Exception:
		try:
			if os.path.exists(thumb_path):
				os.remove(thumb_path)
		except Exception:
			pass
		return None


@app.route('/cloud/api/thumbnail_file')
def thumbnail_file():
	"""Serve a previously-generated thumbnail by hash (no regeneration)."""
	h = request.args.get('h')
	if not h:
		return jsonify(error='missing_hash'), 400
	thumbs = _thumbs_dir()
	thumb_path = os.path.join(thumbs, f"{h}.jpg")
	if not os.path.exists(thumb_path):
		return jsonify(error='thumbnail_not_found'), 404
	try:
		return send_file(thumb_path, mimetype='image/jpeg')
	except Exception as e:
		logging.exception('thumbnail_file send failed')
		return jsonify(error=str(e)), 500


@app.route("/login", methods=["POST"])
def login():
	token = jwt.encode({
		"user": "admin",
		"exp": datetime.datetime.utcnow() + datetime.timedelta(minutes=30)
	}, SECRET, algorithm="HS256")
	return jsonify(token=token)


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
	# Prefer X-Forwarded headers (set by reverse proxy) so the redirect_uri
	# points to the public origin instead of the internal gunicorn host.
	proto = request.headers.get('X-Forwarded-Proto') or request.scheme
	host = request.headers.get('X-Forwarded-Host') or request.headers.get('Host') or request.host
	base = f"{proto}://{host.rstrip('/')}/"
	return urllib.parse.urljoin(base, 'cloud/api/oauth/callback')


@app.route('/oauth/start')
def oauth_start():

	try:
		client_id = os.environ.get('GOOGLE_CLIENT_ID')
		if not client_id:
			# Provide a helpful HTML page instead of a bare 500 so admins see configuration guidance.
			return _access_denied_page('OAuth is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'), 200
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
			# Not requesting offline access by default; keep sign-in simple
		}
		auth_url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urllib.parse.urlencode(params)
		return ('', 302, {'Location': auth_url})
	except Exception as e:
		logging.exception('oauth_start failed')
		return _access_denied_page('Internal error during OAuth start'), 500



@app.route('/oauth/callback')
def oauth_callback():

	try:
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
		if not stored or stored.get('expires', 0) < int(time.time()):
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
			req = urllib.request.Request(token_url, data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'})
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
		if payload.get('aud') != client_id:
			return _access_denied_page('Invalid token audience'), 200
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

		# Redirect to the UI root with a cache-busting timestamp so browsers fetch updated bundles
		app_url = "/cloud/"
		short_token = token[:32] + '...' if token and len(token) > 32 else token
		user_dbg = json.dumps(user_info)

		# Build minimal page that writes to localStorage and redirects
		# Redirect to UI root with token and user in the fragment so the client can store them
		try:
			# Use a relative redirect so the browser keeps the original public origin
			frag_token = urllib.parse.quote(token, safe='')
			frag_user = urllib.parse.quote(json.dumps(user_info), safe='')
			redirect_url = f"{app_url}#token={frag_token}&user={frag_user}"
			return ('', 302, {'Location': redirect_url})
		except Exception:
			logging.exception('oauth_callback redirect failed')
			from flask import make_response
			html = '<!doctype html><html><body><h2>Signed in.</h2><p>Please return to the app.</p></body></html>'
			resp = make_response(html)
			resp.headers['Content-Type'] = 'text/html; charset=utf-8'
			return resp
	except Exception:
		logging.exception('oauth_callback failed')
		return _access_denied_page('Internal error during OAuth callback'), 500

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
	return os.environ.get('FILES_ROOT', '/')

def _safe_path(path):
	"""Ensure path stays within FILES_ROOT"""
	base_dir = _get_files_base()
	full_path = os.path.normpath(os.path.join(base_dir, path.lstrip('/')))
	if not full_path.startswith(base_dir):
		return None
	return full_path

@app.route("/files")
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
		if mimetype.startswith('video/') and not request.args.get('raw'):
			html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Preview</title>
    <style>
        body {{
            margin: 0;
            padding: 0;
            background: black;
            overflow: hidden;
        }}
        video {{
            width: 100vw;
            height: 100vh;
            object-fit: contain;
            background: black;
        }}
    </style>
</head>
<body>
    <video controls autoplay>
        <source src="/cloud/api/files/preview?path={path}&token={token}&raw=1" type="{mimetype}">
        Your browser does not support the video tag.
    </video>
</body>
</html>'''
			return html, 200, {'Content-Type': 'text/html'}
		else:
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

def get_local_network_range():
	"""Get the local network CIDR range"""
	import subprocess
	try:
		result = subprocess.run(['ip', 'route', 'get', '1.1.1.1'], capture_output=True, text=True)
		if result.returncode == 0:
			parts = result.stdout.split()
			for i, part in enumerate(parts):
				if part == 'src' and i + 1 < len(parts):
					local_ip = parts[i + 1]
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
		
		if not any(d['ip'] == server_ip for d in devices):
			devices.insert(0, {
				'ip': server_ip,
				'hostname': socket.gethostname(),
				'online': True,
				'is_server': True,
				'services': [{'port': 80, 'name': 'http'}, {'port': 443, 'name': 'https'}]
			})
		
		devices.sort(key=lambda d: (not d.get('is_server'), tuple(map(int, d['ip'].split('.')))))
		
		gateway_ip = ''
		try:
			gw_result = subprocess.run(['ip', 'route'], capture_output=True, text=True)
			for line in gw_result.stdout.split('\n'):
				if line.startswith('default'):
					gateway_ip = line.split()[2]
					break
		except:
			pass
		
		return jsonify(
			devices=devices,
			network=network_range,
			server_ip=server_ip,
			gateway=gateway_ip,
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
		return hostname.split('.')[0]
	except:
		return ''

@app.route("/network/device/<ip>/ports")
@protected
def scan_device_ports(ip):
	"""Scan common ports on a device"""
	import socket
	
	try:
		parts = ip.split('.')
		if len(parts) != 4 or not all(0 <= int(p) <= 255 for p in parts):
			return jsonify(error='Invalid IP address'), 400
		
		first_octet = int(parts[0])
		second_octet = int(parts[1])
		is_private = (
			first_octet == 10 or
			(first_octet == 172 and 16 <= second_octet <= 31) or
			(first_octet == 192 and second_octet == 168) or
			first_octet == 127
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
		
		gateway = ''
		try:
			result = subprocess.run(['ip', 'route'], capture_output=True, text=True)
			for line in result.stdout.split('\n'):
				if line.startswith('default'):
					gateway = line.split()[2]
					break
		except:
			pass
		
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

@app.route("/cloud/api/health")
def health_alias():
	return health()

@app.route("/cloud/api/metrics")
def metrics_alias():
	return metrics()

@app.route("/cloud/api/network/scan")
def network_scan_alias():
	return network_scan()

@app.route("/cloud/api/network/device/<ip>/ports")
def scan_device_ports_alias(ip):
	return scan_device_ports(ip)

@app.route("/cloud/api/network/info")
def network_info_alias():
	return network_info()


@app.route("/storage/devices")
@protected
def storage_devices():
	parts = []
	try:
		for p in psutil.disk_partitions(all=False):
			if not p.mountpoint:
				continue
			if p.fstype in ('tmpfs', 'devtmpfs'):
				continue
			try:
				usage = psutil.disk_usage(p.mountpoint)
			except Exception:
				continue
			parts.append({
				'device': p.device,
				'mountpoint': p.mountpoint,
				'fstype': p.fstype,
				'total': usage.total,
				'used': usage.used,
				'free': usage.free,
				'percent': usage.percent
			})
	except Exception as e:
		return jsonify(error=str(e)), 500
	return jsonify(devices=parts)


@app.route("/storage/backup", methods=["POST"])
@protected
def storage_backup():
	data = request.get_json() or {}
	src = data.get('source')
	if not src:
		return jsonify(error='missing_source'), 400
	base = _get_files_base()
	dest_base = os.path.join(base, 'Backups')
	try:
		os.makedirs(dest_base, exist_ok=True)
	except Exception as e:
		return jsonify(error=str(e)), 500
	if not os.path.exists(src):
		return jsonify(error='source_not_found'), 404
	try:
		usage = psutil.disk_usage(src)
		free = psutil.disk_usage(base).free
		if free < usage.used:
			return jsonify(error='insufficient_space'), 400
		import shutil
		label = os.path.basename(os.path.normpath(src)) or 'device'
		dest = os.path.join(dest_base, label)
		if os.path.exists(dest):
			shutil.rmtree(dest)
		shutil.copytree(src, dest)
		RECENT_BACKUPS.appendleft({'when': datetime.datetime.utcnow().isoformat(), 'source': src, 'dest': dest})
		return jsonify(success=True, dest=dest)
	except Exception as e:
		logging.exception('backup failed')
		return jsonify(error=str(e)), 500

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


@app.route('/files/upload_chunk', methods=['POST'])
@protected
def upload_chunk():
	upload_id = request.form.get('upload_id')
	index = request.form.get('index')
	total = request.form.get('total')
	filename = request.form.get('filename')
	path = request.form.get('path', '/')
	if 'chunk' not in request.files or not upload_id or index is None:
		return jsonify(error='missing_parameters'), 400
	try:
		tmp_base = os.path.join(tempfile.gettempdir(), 'pincerna_uploads')
		os.makedirs(tmp_base, exist_ok=True)
		upload_dir = os.path.join(tmp_base, upload_id)
		os.makedirs(upload_dir, exist_ok=True)
		chunk_file = request.files['chunk']
		chunk_path = os.path.join(upload_dir, f"chunk_{int(index)}")
		chunk_file.save(chunk_path)
		return jsonify(success=True)
	except Exception as e:
		logging.exception('upload chunk failed')
		return jsonify(error=str(e)), 500


@app.route('/files/upload_complete', methods=['POST'])
@protected
def upload_complete():
	data = request.get_json() or {}
	upload_id = data.get('upload_id')
	filename = data.get('filename')
	path = data.get('path', '/')
	if not upload_id or not filename:
		return jsonify(error='missing_parameters'), 400
	tmp_base = os.path.join(tempfile.gettempdir(), 'pincerna_uploads')
	upload_dir = os.path.join(tmp_base, upload_id)
	full_path = _safe_path(path)
	if not full_path:
		return jsonify(error='invalid_path'), 400
	try:
		parts = sorted([p for p in os.listdir(upload_dir) if p.startswith('chunk_')], key=lambda x: int(x.split('_')[1]))
		dest_file = os.path.join(full_path, filename)
		with open(dest_file, 'wb') as wfd:
			for p in parts:
				with open(os.path.join(upload_dir, p), 'rb') as rfd:
					shutil.copyfileobj(rfd, wfd)
		shutil.rmtree(upload_dir, ignore_errors=True)
		return jsonify(success=True, path=dest_file)
	except Exception as e:
		logging.exception('complete upload failed')
		return jsonify(error=str(e)), 500

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


@app.route("/cloud/api/storage/devices")
def storage_devices_alias():
	return storage_devices()


@app.route("/cloud/api/storage/backup", methods=["POST"])
def storage_backup_alias():
	return storage_backup()


@app.route('/cloud/api/storage/status')
def storage_status_alias():
	return jsonify(list(RECENT_BACKUPS))


@app.route('/cloud/api/files/upload_chunk', methods=['POST'])
def files_upload_chunk_alias():
	return upload_chunk()


@app.route('/cloud/api/files/upload_complete', methods=['POST'])
def files_upload_complete_alias():
	return upload_complete()


@app.route('/cloud/api/thumbnail')
def thumbnail_alias():
	path = request.args.get('path', '')
	full = _safe_path(path)
	if not full or not os.path.isfile(full):
		return jsonify(error='file_not_found'), 404
	try:
		base = _get_files_base()
		thumbs = os.path.join(base, '.thumbs')
		os.makedirs(thumbs, exist_ok=True)
		h = hashlib.md5(full.encode('utf-8')).hexdigest()
		thumb_path = os.path.join(thumbs, f"{h}.jpg")
		if not os.path.exists(thumb_path):
			try:
				cmd = ['ffmpeg', '-y', '-ss', '5', '-i', full, '-frames:v', '1', '-q:v', '2', thumb_path]
				subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
			except Exception:
				return jsonify(error='thumbnail_failed'), 500
		return send_file(thumb_path, mimetype='image/jpeg')
	except Exception as e:
		logging.exception('thumbnail error')
		return jsonify(error=str(e)), 500


@app.route('/cloud/api/streaming/videos')
def streaming_videos():
	"""Return a list of video files found under FILES_ROOT (search recursive).
	Paths are returned relative to FILES_ROOT (leading slash), suitable for /files/preview calls.
	"""
	try:
		base = _get_files_base()
		video_exts = {'.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.flv'}
		results = []
		for root, dirs, files in os.walk(base):
			# Skip system directories
			dirs[:] = [d for d in dirs if d not in ('proc', 'sys', 'dev', 'run', 'tmp', 'var', 'etc', 'boot', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'opt', 'root', 'lost+found') and not d.startswith('.')]
			for fname in files:
				ext = os.path.splitext(fname)[1].lower()
				if ext in video_exts:
					full = os.path.join(root, fname)
					try:
						stat = os.stat(full)
						rel = os.path.relpath(full, base)
						rel_path = '/' + rel.replace('\\', '/')
						results.append({
							'name': fname,
							'path': rel_path,
							'size': stat.st_size,
							'mtime': datetime.datetime.fromtimestamp(stat.st_mtime).isoformat()
						})
					except Exception:
						pass
		# sort by mtime desc
		results.sort(key=lambda x: x.get('mtime', ''), reverse=True)
		# limit to 1000 results to avoid huge responses
		return jsonify(files=results[:1000])
	except Exception as e:
		logging.exception('streaming videos scan failed')
		return jsonify(error=str(e)), 500


@app.route('/cloud/api/streaming/index')
def streaming_index():
	"""Return the video manifest, filtering out videos without thumbnails."""
	try:
		manifest_path = _get_files_base() + "/.video_index.json"
		if os.path.exists(manifest_path):
			with open(manifest_path, 'r') as f:
				data = json.load(f)
			filtered_files = []
			for f in data.get('files', []):
				h = f.get('thumbnail', '').split('?h=')[-1]
				if h:
					thumb_path = _thumbs_dir() + "/" + h + ".jpg"
					if os.path.exists(thumb_path):
						filtered_files.append(f)
			return jsonify(files=filtered_files)
		else:
			return jsonify(files=[])
	except Exception as e:
		logging.exception(f'Error loading streaming index: {e}')
		return jsonify(error=str(e)), 500


@app.route('/cloud/api/streaming')
def streaming():
	"""Return the video manifest, filtering out videos without thumbnails."""
	manifest_path = _get_files_base() + "/.video_index.json"
	if os.path.exists(manifest_path):
		with open(manifest_path, 'r') as f:
			data = json.load(f)
		# Filter out videos without existing thumbnails
		filtered_files = []
		for f in data.get('files', []):
			h = f.get('thumbnail', '').split('?h=')[-1]
			if h:
				thumb_path = _thumbs_dir() + "/" + h + ".jpg"
				if os.path.exists(thumb_path):
					filtered_files.append(f)
		return jsonify(files=filtered_files)
	else:
		return jsonify(files=[])


@app.route('/cloud/api/streaming/video')
def streaming_video_detail():
	path = request.args.get('path', '')
	if not path:
		return jsonify(error='missing_path'), 400
	# normalize path (path given is relative to FILES_ROOT, leading slash)
	full = _safe_path(path)
	if not full or not os.path.isfile(full):
		return jsonify(error='file_not_found'), 404
	with VIDEO_INDEX_LOCK:
		info = VIDEO_INDEX.get(full)
	if info:
		return jsonify(info)
	# fallback: build minimal metadata
	try:
		stat = os.stat(full)
		thumb = _ensure_thumbnail(full)
		rel_thumb = None
		if thumb:
			h = hashlib.md5(full.encode('utf-8')).hexdigest()
			rel_thumb = '/cloud/api/thumbnail_file?h=' + h
		info = {
			'name': os.path.basename(full),
			'path': path,
			'size': stat.st_size,
			'mtime': datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(),
			'thumbnail': rel_thumb
		}
		return jsonify(info)
	except Exception as e:
		logging.exception('video detail failed')
		return jsonify(error=str(e)), 500


if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5002)


known_mounts = set()
backup_lock = threading.Lock()

def _storage_watcher_loop():
	poll = int(os.environ.get('FILES_DEVICE_POLL_INTERVAL', '15'))
	auto_backup = os.environ.get('AUTO_BACKUP_ON_ATTACH', '1') == '1'
	base = _get_files_base()
	while True:
		try:
			current = set()
			for p in psutil.disk_partitions(all=False):
				if not p.mountpoint:
					continue
				if p.fstype in ('tmpfs', 'devtmpfs'):
					continue
				current.add(p.mountpoint)

			added = current - known_mounts
			removed = known_mounts - current

			if added:
				for m in added:
					logging.info('storage attached %s', m)
					if auto_backup:
						src = os.path.join(m, 'Streaming')
						if os.path.exists(src):
							try:
								dest_base = os.path.join(base, 'Backups')
								os.makedirs(dest_base, exist_ok=True)
								label = os.path.basename(os.path.normpath(m)) or 'device'
								dest = os.path.join(dest_base, label)
								with backup_lock:
									if os.path.exists(dest):
										shutil.rmtree(dest)
									shutil.copytree(src, dest, dirs_exist_ok=True)
								logging.info('backup completed %s -> %s', src, dest)
								RECENT_BACKUPS.appendleft({'when': datetime.datetime.utcnow().isoformat(), 'source': src, 'dest': dest})
							except Exception:
								logging.exception('auto backup failed')

			if removed:
				for m in removed:
					logging.info('storage removed %s', m)

			known_mounts.clear()
			known_mounts.update(current)
		except Exception:
			logging.exception('storage watcher error')
		time.sleep(poll)


def _video_indexer_loop():
	"""Background thread that scans FILES_ROOT for video files and keeps an index with thumbnails."""
	interval = int(os.environ.get('VIDEO_INDEX_INTERVAL', '30'))
	video_exts = {'.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.flv'}
	base = _get_files_base()
	while True:
		try:
			new_index = {}
			for root, dirs, files in os.walk(base):
				dirs[:] = [d for d in dirs if d not in ('proc', 'sys', 'dev', 'run', 'tmp', 'var', 'etc', 'boot', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'opt', 'root', 'lost+found') and not d.startswith('.')]
				for fname in files:
					ext = os.path.splitext(fname)[1].lower()
					if ext not in video_exts:
						continue
					full = os.path.join(root, fname)
					try:
						stat = os.stat(full)
						mtime = int(stat.st_mtime)
						size = stat.st_size
						# Check existing entry to avoid regenerating thumbnail unnecessarily
						with VIDEO_INDEX_LOCK:
							existing = VIDEO_INDEX.get(full)
						if existing and existing.get('mtime_ts') == mtime and existing.get('size') == size:
							# reuse existing
							new_index[full] = existing
							continue
						# generate thumbnail (best-effort)
						thumb_path = _ensure_thumbnail(full)
						thumb_url = None
						rel = '/' + os.path.relpath(full, base).replace('\\', '/')
						if thumb_path:
							# compute hash and provide a stable thumbnail-file URL
							h = hashlib.md5(full.encode('utf-8')).hexdigest()
							thumb_url = '/cloud/api/thumbnail_file?h=' + h
						item = {
							'name': fname,
							'path': rel,
							'size': size,
							'mtime': datetime.datetime.fromtimestamp(stat.st_mtime).isoformat(),
							'mtime_ts': mtime,
							'thumbnail': thumb_url
						}
						new_index[full] = item
					except Exception:
						pass
			# swap indexes
			with VIDEO_INDEX_LOCK:
				VIDEO_INDEX.clear()
				VIDEO_INDEX.update(new_index)
		except Exception:
			logging.exception('video indexer error')
		time.sleep(interval)

@app.before_first_request
def _start_storage_watcher():
	try:
		base = _get_files_base()
		streaming_dir = os.path.join(base, 'Streaming')
		backups_dir = os.path.join(base, 'Backups')
		os.makedirs(streaming_dir, exist_ok=True)
		os.makedirs(backups_dir, exist_ok=True)
	except Exception:
		logging.exception('failed to ensure streaming/backups directories')
	t = threading.Thread(target=_storage_watcher_loop, daemon=True)
	t.start()

	# start video indexer thread
	t2 = threading.Thread(target=_video_indexer_loop, daemon=True)
	t2.start()