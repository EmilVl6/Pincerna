#define OAUTH_STATE "/tmp/pincerna_oauth_state.json"

#include <pistache/endpoint.h>
#include <pistache/router.h>
#include <pistache/http.h>
#include <pistache/net.h>
#include <nlohmann/json.hpp>
#include <fstream>
#include <unordered_map>
#include <mutex>
#include <string>
#include <vector>
#include <memory>
#include <filesystem>
#include <chrono>
#include <thread>
#include <atomic>
#include <iostream>

#include <openssl/hmac.h>
#include <openssl/evp.h>
#include <random>


using namespace std; using namespace Pistache; using json = nlohmann::json;

string base64UrlEncode(const string& input) {
	static const char* b64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	string b64;
	int val = 0, valb = -6;
	for (unsigned char c : input) {
		val = (val << 8) + c;
		valb += 8;
		while (valb >= 0) {
			b64.push_back(b64_chars[(val >> valb) & 0x3F]);
			valb -= 6;
		}
	}
	if (valb > -6) b64.push_back(b64_chars[((val << 8) >> (valb + 8)) & 0x3F]);
	while (b64.size() % 4) b64.push_back('=');
	// Convert to base64url
	for (auto& c : b64) {
		if (c == '+') c = '-';
		else if (c == '/') c = '_';
	}
	while (!b64.empty() && b64.back() == '=') b64.pop_back();
	return b64;
}

string base64UrlDecode(const string& input) {
	string b64 = input;
	for (auto& c : b64) {
		if (c == '-') c = '+';
		else if (c == '_') c = '/';
	}
	while (b64.size() % 4) b64.push_back('=');
	string out;
	int val = 0, valb = -8;
	for (unsigned char c : b64) {
		if (isalnum(c) || c == '+' || c == '/') val = (val << 6) + (c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : 63);
		else continue;
		valb += 6;
		if (valb >= 0) {
			out.push_back(char((val >> valb) & 0xFF));
			valb -= 8;
		}
	}
	return out;
}

string hmacSha256(const string& data, const string& key) {
	unsigned char hash[EVP_MAX_MD_SIZE];
	unsigned int len = 0;
	HMAC(EVP_sha256(), key.data(), key.size(), (const unsigned char*)data.data(), data.size(), hash, &len);
	return string((char*)hash, len);
}

string createJwt(const json& payload, const string& secret) {
	json header = { {"alg", "HS256"}, {"typ", "JWT"} };
	string header_b64 = base64UrlEncode(header.dump());
	string payload_b64 = base64UrlEncode(payload.dump());
	string to_sign = header_b64 + "." + payload_b64;
	string signature = base64UrlEncode(hmacSha256(to_sign, secret));
	return to_sign + "." + signature;
}

bool verifyJwt(const string& token, const string& secret, json& outPayload) {
	size_t p1 = token.find('.');
	size_t p2 = token.rfind('.');
	if (p1 == string::npos || p2 == string::npos || p1 == p2) return false;
	string header_b64 = token.substr(0, p1);
	string payload_b64 = token.substr(p1 + 1, p2 - p1 - 1);
	string sig_b64 = token.substr(p2 + 1);
	string to_sign = header_b64 + "." + payload_b64;
	string expected_sig = base64UrlEncode(hmacSha256(to_sign, secret));
	if (sig_b64 != expected_sig) return false;
	try {
		outPayload = json::parse(base64UrlDecode(payload_b64));
	} catch (...) {
		return false;
	}
	return true;
}

string SECRET;
mutex secretMutex;

string generateSecret(size_t length = 64) {
	static const char chars[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=";
	random_device rd;
	mt19937 gen(rd());
	uniform_int_distribution<> dis(0, sizeof(chars) - 2);	
	string secret;
	for (size_t i = 0; i < length; ++i) {
		secret += chars[dis(gen)];
	}
	return secret;
}

// Test
void rotateSecret(unsigned intervalSeconds = 3600) {
	thread([intervalSeconds]() {
		while (true) {
			{
				lock_guard<mutex> lock(secretMutex);
				SECRET = generateSecret();
			}
			this_thread::sleep_for(chrono::seconds(intervalSeconds));
		}
	}).detach();
}

unordered_map<string, string> oauthStore;
mutex oauthMutex;

// Replace System
vector<string> allowedUsers = {"emilvinod@gmail.com"};

void loadOauthStore() {
	lock_guard<mutex> lock(oauthMutex);
	ifstream f(OAUTH_STATE);
	if (f) {
		json j;
		f >> j;
		for (auto& el : j.items()) {
			oauthStore[el.key()] = el.value();
		}
	}
}

void saveOauthStore() {
	lock_guard<mutex> lock(oauthMutex);
	json j(oauthStore);
	ofstream f(OAUTH_STATE);
	f << j.dump();
}

class ApiHandler {
public:
	explicit ApiHandler() {}

	void setupRoutes(Rest::Router& router) {
		using namespace Rest;
		Routes::Get(router, "/health", Routes::bind(&ApiHandler::doHealth, this));
		Routes::Post(router, "/login", Routes::bind(&ApiHandler::doLogin, this));
		Routes::Post(router, "/verify_turnstile", Routes::bind(&ApiHandler::doVerifyTurnstile, this));
		Routes::Post(router, "/verify_google", Routes::bind(&ApiHandler::doVerifyGoogle, this));
		Routes::Get(router, "/config", Routes::bind(&ApiHandler::doConfig, this));
	}

	void doHealth(const Rest::Request&, Http::ResponseWriter response) {
		response.send(Http::Code::Ok, "OK");
	}

	void doLogin(const Rest::Request& request, Http::ResponseWriter response) {
		// Example: create JWT for user
		json payload = {
			{"sub", "user_id"},
			{"email", "emilvinod@gmail.com"},
			{"iat", (int)time(nullptr)},
			{"exp", (int)(time(nullptr) + 3600)}
		};
		string token;
		{
			lock_guard<mutex> lock(secretMutex);
			token = createJwt(payload, SECRET);
		}
		json resp = { {"token", token} };
		response.send(Http::Code::Ok, resp.dump());
	}

	void doVerifyTurnstile(const Rest::Request& request, Http::ResponseWriter response) {
		json resp = { {"success", true}, {"detail", "turnstile placeholder"} };
		response.send(Http::Code::Ok, resp.dump());
	}

	void doVerifyGoogle(const Rest::Request& request, Http::ResponseWriter response) {
		json resp = { {"token", "jwt_token_placeholder"} };
		response.send(Http::Code::Ok, resp.dump());
	}

	void doConfig(const Rest::Request&, Http::ResponseWriter response) {
		json resp = { {"turnstile_sitekey", "sitekey_placeholder"} };
		response.send(Http::Code::Ok, resp.dump());
	}

	void sendError(Http::ResponseWriter response, const string& msg, Http::Code code = Http::Code::Bad_Request) {
		json resp = { {"error", msg} };
		response.send(code, resp.dump());
	}
};

int main() {
	loadOauthStore();
	rotateSecret();

	Port port(5002);
	int threads = 4;
	Address addr(Ipv4::any(), port);

	auto apiHandler = make_shared<ApiHandler>();
	Rest::Router router;
	apiHandler->setupRoutes(router);

	auto opts = Http::Endpoint::options().threads(threads);
	Http::Endpoint server(addr);
	server.init(opts);
	server.setHandler(router.handler());
	server.serve();
	server.shutdown();
	saveOauthStore();
	return 0;
}