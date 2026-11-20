import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";


/*
 * Runs the Vercel functions in api/ during `npm run dev`, so the AI
 * helpers work on localhost without the Vercel CLI. On Vercel itself the
 * files in api/ are deployed as serverless functions and this isn't used.
 */
const API_ROUTES = ["agent", "link"];

function localApi() {
  return {
    name: "local-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        const route = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!API_ROUTES.includes(route)) return next();
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          // leave body empty; the handler answers 400
        }
        // Small stand-in for Vercel's response helpers
        const vercelRes = {
          setHeader: (k, v) => res.setHeader(k, v),
          status(code) {
            res.statusCode = code;
            return this;
          },
          json(data) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(data));
            return this;
          },
        };
        try {
          const { default: handler } = await server.ssrLoadModule(`/api/${route}.js`);
          await handler({ method: req.method, headers: req.headers, body }, vercelRes);
        } catch (err) {
          console.error(err);
          vercelRes.status(500).json({ error: "Local API crashed. See the terminal." });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Make server-only secrets in .env.local (like ANTHROPIC_API_KEY) visible to
  // the local API. They are not VITE_-prefixed, so they never reach the browser.
  const env = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    plugins: [react(), localApi()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: "./src/setupTests.js",
      // Claude skill folders ship their own node:test files; they aren't app tests.
      exclude: ["**/node_modules/**", "**/dist/**", ".agents/**", ".claude/**"],
    },
  };
});
