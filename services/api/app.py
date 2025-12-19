from flask import Flask, jsonify, request
import jwt
import datetime
import logging
import psutil

app = Flask(__name__)
SECRET = "bartendershandbook"

logging.basicConfig(filename="api.log", level=logging.INFO)

@app.route("/login", methods=["POST"])
def login():
	token = jwt.encode({
		"user": "admin",
		"exp": datetime.datetime.utcnow() + datetime.timedelta(minutes=30)
	}, SECRET, algorithm="HS256")
	return jsonify(token=token)

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
