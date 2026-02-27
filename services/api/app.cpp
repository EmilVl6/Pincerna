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
#include <jwt-cpp/jwt.h>

using namespace std; using namespace Pistache; using json = nlohmann::json;

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
		json resp = { {"token", "jwt_token_placeholder"} };
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