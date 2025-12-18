from flask import Flask, jsonify

app = Flask(__name__)

@app.route("/health")
def health():
	return jsonify(status="ok")

@app.route("/data")
def data():
	return jsonify(message="Local Bartender (CLASSY SERVER) Breathes")

if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5002)
