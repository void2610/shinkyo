import type { ReactNode } from "react";
import {
	isRouteErrorResponse,
	Link,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useRouteLoaderData,
} from "react-router";
import { displayName } from "../src/web/format.ts";
import type { Route } from "./+types/root";
import { appContext } from "./context";
import "./app.css";

export function loader({ context }: Route.LoaderArgs) {
	const { person, people } = context.get(appContext);
	return { name: displayName(people, person) };
}

// 描画前に配色を決めないと、ダークモードで一瞬白く光る
const themeScript = `if(matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.classList.add("dark")`;

export function Layout({ children }: { children: ReactNode }) {
	const data = useRouteLoaderData<typeof loader>("root");
	return (
		<html lang="ja" suppressHydrationWarning>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="robots" content="noindex" />
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: 固定の文字列で、利用者の入力は含まない */}
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
				<Meta />
				<Links />
			</head>
			<body className="min-h-screen bg-background text-foreground antialiased">
				<header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
					<div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6">
						<Link
							className="font-heading text-base font-semibold tracking-tight"
							to="/"
						>
							shinkyo
						</Link>
						<span className="text-sm text-muted-foreground">賃貸探し</span>
						{data && (
							<span className="ml-auto text-sm text-muted-foreground">
								{data.name}
							</span>
						)}
					</div>
				</header>
				<main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const message = isRouteErrorResponse(error)
		? error.status === 404
			? "見つかりません。"
			: `${error.status} ${error.statusText}`
		: "予期しないエラーが起きました。";
	return (
		<div className="py-24 text-center">
			<p className="text-muted-foreground">{message}</p>
			<Link
				className="mt-4 inline-block text-sm underline underline-offset-4"
				to="/"
			>
				一覧へ戻る
			</Link>
		</div>
	);
}
