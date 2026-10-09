import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss(), reactRouter()],
	resolve: { tsconfigPaths: true },
	// 画面のサーバー側コードは Bun の上で動くので、Bun 固有のモジュールは束ねない
	ssr: { external: ["bun:sqlite"] },
});
