/**
 * Best-effort country/city lookup for an intrusion alert's source IP.
 *
 * This is network-routing geolocation, not a street address: it resolves to
 * roughly where the IP's ISP/ASN hands off traffic in that city, which can be
 * a datacenter, a mobile carrier's regional gateway, or a VPN exit node many
 * kilometers from the actual device. A house number is not obtainable from
 * an IP address by any lookup service — only the ISP holds that mapping, and
 * only law enforcement can compel them to disclose it.
 */

export interface IpGeoInfo {
	country?: string;
	regionName?: string;
	city?: string;
	isp?: string;
	lat?: number;
	lon?: number;
}

const LOOKUP_TIMEOUT_MS = 3000;

// RFC1918/loopback/link-local ranges and the "unknown" sentinel requestIp()
// falls back to: none of these resolve to anything on a public map.
const NON_PUBLIC_IP = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:|unknown$)/i;

export function isPublicIp(ip: string | undefined): boolean {
	return Boolean(ip) && !NON_PUBLIC_IP.test(ip!);
}

/** Never throws; a lookup failure should never block or break an alert. */
export async function lookupIpGeo(ip: string): Promise<IpGeoInfo | null> {
	if (!isPublicIp(ip)) return null;
	try {
		const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,isp,lat,lon`, {
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { status?: string } & IpGeoInfo;
		if (data.status !== "success") return null;
		return { country: data.country, regionName: data.regionName, city: data.city, isp: data.isp, lat: data.lat, lon: data.lon };
	} catch {
		return null;
	}
}

export function formatGeoLine(geo: IpGeoInfo | null): string {
	if (!geo) return "ตำแหน่ง: ไม่ทราบ (IP ภายใน หรือ lookup ไม่สำเร็จ)";
	const place = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ") || "ไม่ทราบ";
	const isp = geo.isp ? ` · ISP: ${geo.isp}` : "";
	const map =
		geo.lat !== undefined && geo.lon !== undefined ? `\nแผนที่ (โดยประมาณ): https://www.google.com/maps?q=${geo.lat},${geo.lon}` : "";
	return `ตำแหน่ง: ${place}${isp}${map}`;
}
