import { z } from "zod";

export const GSI_ENDPOINT =
	"https://msearch.gsi.go.jp/address-search/AddressSearch";

export type LatLon = { lat: number; lon: number };
export type Geocoder = (address: string) => Promise<LatLon | null>;

const resultSchema = z.array(
	z.object({
		geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
	}),
);

// SUUMO の住所は町丁目までなので、座標はその町丁目の代表点になる
export function createGsiGeocoder(
	fetchImpl: (url: string) => Promise<Response>,
): Geocoder {
	return async (address) => {
		const url = `${GSI_ENDPOINT}?q=${encodeURIComponent(address.normalize("NFKC"))}`;
		const res = await fetchImpl(url);
		if (!res.ok) throw new Error(`国土地理院の住所検索: HTTP ${res.status}`);
		const [first] = resultSchema.parse(await res.json());
		if (!first) return null;
		const [lon, lat] = first.geometry.coordinates;
		return { lat, lon };
	};
}
