/**
 * SSRF-safe URL fetching for the web tools (hosted-web phase 3).
 *
 * A public visitor can ask the agent to fetch arbitrary URLs. Without this
 * guard, `web_fetch` / `web_fetch_pdf` would happily reach loopback, private
 * LANs, cloud metadata endpoints, and Unix-socket-ish aliases from the app
 * server. The guard checks the literal host, then resolves every A/AAAA
 * record, and re-checks each redirect hop.
 *
 * This is a network boundary, not a browser sandbox: DNS rebinding between
 * the lookup and the connect is still theoretically possible. The hosted
 * beta also keeps Chromium/demo execution off, so no browser follows a URL
 * independently.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"instance-data",
]);

function ipv4Private(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return true;
	}
	const [a, b, c] = parts as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function ipv6Private(address: string): boolean {
	const lower = address.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
	if (lower.startsWith("ff")) return true;
	if (lower.startsWith("2001:db8")) return true;
	if (lower.startsWith("64:ff9b:")) return true;
	if (lower.startsWith("::ffff:")) {
		const mapped = lower.slice("::ffff:".length);
		return isIP(mapped) === 4 ? ipv4Private(mapped) : true;
	}
	return false;
}

export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return ipv4Private(address);
	if (family === 6) return ipv6Private(address);
	return true;
}

function blockedHostname(host: string): boolean {
	const lower = host.toLowerCase().replace(/\.$/, "");
	return (
		BLOCKED_HOSTS.has(lower) ||
		lower.endsWith(".localhost") ||
		lower.endsWith(".local") ||
		lower.endsWith(".internal")
	);
}

/** Throws unless `raw` is a public http(s) URL. */
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("invalid URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http(s) URLs are supported");
	}
	if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");

	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (blockedHostname(host)) throw new Error("This host is not allowed");

	if (isIP(host)) {
		if (isPrivateAddress(host)) throw new Error("Private or reserved addresses are not allowed");
		return url;
	}

	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await lookup(host, { all: true, verbatim: true });
	} catch {
		throw new Error("The host could not be resolved");
	}
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error("Private or reserved addresses are not allowed");
	}
	return url;
}

/** Fetch with the SSRF gate applied to the initial URL AND every redirect. */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
	let current = await assertSafeHttpUrl(raw);
	for (let hop = 0; hop < 5; hop++) {
		const response = await fetch(current, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) return response;
			current = await assertSafeHttpUrl(new URL(location, current).toString());
			continue;
		}
		return response;
	}
	throw new Error("Too many redirects");
}
