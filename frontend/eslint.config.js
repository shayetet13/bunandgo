import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config({ ignores: ["node_modules", "dist"] }, js.configs.recommended, ...tseslint.configs.recommended, {
	languageOptions: { globals: globals.browser },
	plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
	rules: {
		// Only the two long-established hooks rules — the rest of
		// eslint-plugin-react-hooks v7's "recommended" set targets React
		// Compiler compatibility and flags plenty of valid existing
		// patterns (fetch-on-mount effects, latest-value refs) that
		// aren't bugs here.
		"react-hooks/rules-of-hooks": "error",
		"react-hooks/exhaustive-deps": "warn",
		"react-refresh/only-export-components": "warn",
		"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
		"no-console": "off",
	},
});
