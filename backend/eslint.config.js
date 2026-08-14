import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// linejs-core is vendored/adapted reference code (see project README) —
	// never edited as part of app changes, so it's excluded from linting here.
	{ ignores: ["node_modules", "data", "sender", "src/linejs-core/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "warn",
			"no-console": "off",
		},
	},
);
