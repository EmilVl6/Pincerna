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

# Temporary in-memory store for email codes: { email: {code:str, expires:int} }
EMAIL_CODES = {}
# Persist OAUTH state to a small file so restarts don't lose pending flows
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

# load existing store at startup
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
	# connect
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
	# only allow emilvinod@gmail.com for now
	if email != 'emilvinod@gmail.com':
		return jsonify(error='unknown_account'), 400
	# generate code
	code = str(int(100000 + (int(time.time()*1000) % 900000)))
	expires = int(time.time()) + 10*60
	EMAIL_CODES[email] = {'code': code, 'expires': expires}
	# attempt to send via SMTP
	try:
		subject = 'Pincerna sign-in code'
		body = f'Your Pincerna sign-in code is: {code}\n\nThis code expires in 10 minutes.'
		send_smtp_mail(email, subject, body)
		return jsonify(status='sent')
	except Exception as e:
		# if SMTP not configured or send failed, return helpful message
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
	# success — issue JWT token
	token = jwt.encode({
		'user': email,
		'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=12)
	}, SECRET, algorithm='HS256')
	# remove stored code
	try: del EMAIL_CODES[email]
	except: pass
	return jsonify(token=token)

# Aliases under /cloud/api/ to match proxy prefix used by nginx/UI
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
	# return minimal public config for the UI
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
	# verify with Google's tokeninfo endpoint
	try:
		url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': id_token})
		with urllib.request.urlopen(url, timeout=8) as resp:
			payload = json.load(resp)
	except Exception as e:
		logging.exception('google tokeninfo failed')
		return jsonify(error='token_verification_failed', detail=str(e)), 400
	# payload includes email and email_verified
	email = payload.get('email')
	verified = payload.get('email_verified') in ('true', True, '1')
	if not email or not verified:
		return jsonify(error='email_not_verified'), 400
	# check allowed list
	try:
		base = os.path.dirname(__file__)
		allowed_path = os.path.join(base, 'allowed_users.json')
		with open(allowed_path, 'r', encoding='utf-8') as f:
			allowed = json.load(f)
	except Exception:
		allowed = ['emilvinod@gmail.com']
	if email.lower() not in [e.lower() for e in allowed]:
		return jsonify(error='not_allowed'), 403
	# issue token
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
	# Build a redirect URI that points back to this server's /cloud/api/oauth/callback
	# request.host_url includes scheme+host+port with trailing slash
	return urllib.parse.urljoin(request.host_url, 'cloud/api/oauth/callback')


@app.route('/oauth/start')
def oauth_start():
	# Start PKCE OAuth flow: generate state and code_verifier, store and redirect to Google
	client_id = os.environ.get('GOOGLE_CLIENT_ID')
	if not client_id:
		return jsonify(error='missing_client_id'), 500
	state = secrets.token_urlsafe(16)
	code_verifier = secrets.token_urlsafe(64)
	# compute code_challenge (base64url of SHA256)
	sha = hashlib.sha256(code_verifier.encode('utf-8')).digest()
	code_challenge = base64.urlsafe_b64encode(sha).rstrip(b'=').decode('ascii')
	# store
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
	# Exchange code for tokens using stored code_verifier
	error = request.args.get('error')
	if error:
		return f'OAuth error: {error}', 400
	code = request.args.get('code')
	state = request.args.get('state')
	if not code or not state:
		return 'Missing parameters', 400
	stored = OAUTH_STORE.get(state)
	if not stored or stored.get('expires',0) < int(time.time()):
		return 'Invalid or expired state', 400
	code_verifier = stored.get('code_verifier')
	# exchange
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
		return f'Token exchange failed: {e}', 500
	id_token = resp_j.get('id_token')
	if not id_token:
		return 'No id_token returned', 500
	# verify id_token via tokeninfo
	try:
		url = 'https://oauth2.googleapis.com/tokeninfo?' + urllib.parse.urlencode({'id_token': id_token})
		with urllib.request.urlopen(url, timeout=8) as r:
			payload = json.load(r)
	except Exception as e:
		logging.exception('tokeninfo failed')
		return f'id_token verification failed: {e}', 500
	email = payload.get('email')
	verified = payload.get('email_verified') in ('true', True, '1')
	if not email or not verified:
		return _access_denied_page('Email not verified'), 400
	# check allowed
	try:
		base = os.path.dirname(__file__)
		allowed_path = os.path.join(base, 'allowed_users.json')
		with open(allowed_path, 'r', encoding='utf-8') as f:
			allowed = json.load(f)
	except Exception:
		allowed = ['emilvinod@gmail.com']
	if email.lower() not in [e.lower() for e in allowed]:
		return _access_denied_page(), 403
	# get user info from payload
	user_name = payload.get('name', '')
	user_given = payload.get('given_name', '')
	user_picture = payload.get('picture', '')
	# create our JWT
	token = jwt.encode({'user': email, 'name': user_name, 'given_name': user_given, 'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=12)}, SECRET, algorithm='HS256')
	# cleanup
	try:
		del OAUTH_STORE[state]
		_save_oauth_store()
	except:
		pass
	# user info JSON for localStorage
	user_info = json.dumps({'email': email, 'name': user_name, 'given_name': user_given, 'picture': user_picture})
	# respond with small page that stores token in localStorage and redirects
	html = f"""<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body>
	<script>
	  localStorage.setItem('pincerna_token', {json.dumps(token)});
	  localStorage.setItem('pincerna_user', {user_info});
	  window.location.href = '/cloud/';
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
	return jsonify(
		cpu=psutil.cpu_percent(),
		memory=psutil.virtual_memory().percent
	)

if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5002)
