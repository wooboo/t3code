import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { browserIsAuthorized } from "./browser-auth.mjs";
NodeTest.test("anonymous and expired sessions cannot reach the voice pipeline", async () => {
  NodeAssert.equal(
    await browserIsAuthorized({}, "http://localhost", () => {
      throw Error("unexpected");
    }),
    false,
  );
  NodeAssert.equal(
    await browserIsAuthorized({ cookie: "expired" }, "http://localhost", async () =>
      Response.json({ authenticated: false }),
    ),
    false,
  );
  NodeAssert.equal(
    await browserIsAuthorized({ cookie: "valid" }, "http://localhost", async () => {
      throw Error("offline");
    }),
    false,
  );
});
NodeTest.test("forwards browser credentials and accepts authenticated T3 sessions", async () => {
  NodeAssert.equal(
    await browserIsAuthorized(
      { cookie: "browser-session" },
      "http://localhost",
      async (url, options) => {
        NodeAssert.equal(url.pathname, "/api/auth/session");
        NodeAssert.deepEqual(options.headers, { Cookie: "browser-session" });
        return Response.json({ authenticated: true });
      },
    ),
    true,
  );
});
