import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("units/:key", "routes/unit.tsx"),
	route("map", "routes/map.tsx"),
] satisfies RouteConfig;
