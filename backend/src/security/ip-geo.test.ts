import { describe, expect, test } from "bun:test";
import { formatGeoLine, isPublicIp } from "./ip-geo.ts";

describe("isPublicIp", () => {
	test("rejects private and loopback ranges", () => {
		expect(isPublicIp("10.0.0.5")).toBe(false);
		expect(isPublicIp("192.168.1.1")).toBe(false);
		expect(isPublicIp("172.16.0.1")).toBe(false);
		expect(isPublicIp("172.31.255.255")).toBe(false);
		expect(isPublicIp("127.0.0.1")).toBe(false);
		expect(isPublicIp("::1")).toBe(false);
		expect(isPublicIp("fe80::1")).toBe(false);
	});

	test("rejects the requestIp() unknown sentinel", () => {
		expect(isPublicIp("unknown")).toBe(false);
	});

	test("does not reject a 172.x address outside the private /12 block", () => {
		// 172.32.0.0 is public; only 172.16.0.0-172.31.255.255 is RFC1918.
		expect(isPublicIp("172.32.0.1")).toBe(true);
	});

	test("accepts a public IP", () => {
		expect(isPublicIp("8.8.8.8")).toBe(true);
	});

	test("rejects an empty/undefined value", () => {
		expect(isPublicIp(undefined)).toBe(false);
		expect(isPublicIp("")).toBe(false);
	});
});

describe("formatGeoLine", () => {
	test("reports unknown when lookup failed or IP was internal", () => {
		expect(formatGeoLine(null)).toContain("ไม่ทราบ");
	});

	test("joins city/region/country and includes the ISP", () => {
		const line = formatGeoLine({ city: "Bangkok", regionName: "Bangkok", country: "Thailand", isp: "AIS" });
		expect(line).toContain("Bangkok, Bangkok, Thailand");
		expect(line).toContain("ISP: AIS");
	});

	test("adds an approximate map link when coordinates are present", () => {
		const line = formatGeoLine({ city: "Bangkok", lat: 13.75, lon: 100.5 });
		expect(line).toContain("https://www.google.com/maps?q=13.75,100.5");
	});

	test("omits the map link when coordinates are missing", () => {
		const line = formatGeoLine({ city: "Bangkok" });
		expect(line).not.toContain("google.com/maps");
	});
});
