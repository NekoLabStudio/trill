import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						IDENTITY_SECRET: "test-identity-secret",
						SESSION_SECRET: "test-session-secret",
						STEAM_WEB_API_KEY: "test-steam-key",
						GAMES: {
							test: { name: "Test Game", steam_app_id: 480, bundle_ids: ["com.example.test"], play_games: false },
							small: { max_save_bytes: 16, max_save_slots: 2 },
							hosted: { ranked_agreement: "host" },
							strict: { kick_cheaters: true },
							versioned: { min_version: "1.2.0", max_version: "2.0" },
						},
						EMAIL_DRIVER: "log",
						EMAIL_FROM: "Test Game <noreply@example.com>",
					},
				},
			}),
		],
		// The scripts in scripts/ are Node's, tested by Node's own runner (npm test runs both).
		test: { setupFiles: ["./test/apply-migrations.ts"], include: ["test/**/*.test.ts"] },
	};
});
