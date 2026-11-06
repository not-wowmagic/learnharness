/**
 * SSRF guard pins (hosted-web phase 3): literal private/reserved addresses
 * and metadata hostnames never reach the web tools.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertSafeHttpUrl,
	isPrivateAddress,
} from "../src/agent/tools/safe-url.ts";

describe("private address classification", () => {
	it("rejects loopback, RFC1918, link-local, CGNAT, and metadata ranges", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"198.18.0.1",
			"224.0.0.1",
			"255.255.255.255",
			"::1",
			"::",
			"fc00::1",
			"fd12::1",
			"fe80::1",
			"ff02::1",
			"::ffff:127.0.0.1",
		]) {
			assert.equal(isPrivateAddress(address), true, address);
		}
	});

	it("leaves public addresses alone", () => {
		for (const address of [
			"8.8.8.8",
			"1.1.1.1",
			"93.184.216.34",
			"2606:4700:4700::1111",
			"::ffff:8.8.8.8",
		]) {
			assert.equal(isPrivateAddress(address), false, address);
		}
	});
});

describe("safe URL gate", () => {
	it("accepts a public literal http(s) URL", async () => {
		const url = await assertSafeHttpUrl("https://93.184.216.34/path?q=1");
		assert.equal(url.hostname, "93.184.216.34");
	});

	it("rejects non-http schemes, credentials, localhost, and private literals", async () => {
		for (const raw of [
			"file:///etc/passwd",
			"ftp://example.com/file",
			"http://user:pass@93.184.216.34/",
			"http://localhost:3000/",
			"http://metadata.google.internal/",
			"http://127.0.0.1/",
			"http://10.0.0.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://[::1]/",
			"http://[fe80::1]/",
		]) {
			await assert.rejects(() => assertSafeHttpUrl(raw), raw);
		}
	});
});
