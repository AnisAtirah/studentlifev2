// @vitest-environment node
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Control DNS so no test touches the real network.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: actual.default ?? actual, lookup: vi.fn() };
});

const { lookup } = await import("node:dns");
const { isPrivateAddress, readLink, requestOnce, safeLookup, LinkError } = await import("./_readLink.js");

const answer = (address) =>
  lookup.mockImplementation((_host, _opts, cb) => cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]));

// Block body on purpose: a function returned from beforeEach is run as a cleanup hook.
const resetDns = () => {
  lookup.mockReset();
};

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "64:ff9b::7f00:1", "2001:db8::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::127.0.0.1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false));
});

describe("safeLookup", () => {
  beforeEach(resetDns);

  it("returns public answers in the shape Node asked for", async () => {
    answer("93.184.216.34");
    const all = await new Promise((res) => safeLookup("example.com", { all: true }, (e, a) => res([e, a])));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
    const one = await new Promise((res) => safeLookup("example.com", {}, (e, a, f) => res([e, a, f])));
    expect(one).toEqual([null, "93.184.216.34", 4]);
  });

  it("refuses a private answer", async () => {
    answer("10.0.0.5");
    const [err] = await new Promise((res) => safeLookup("evil.test", { all: true }, (...a) => res(a)));
    expect(err).toBeInstanceOf(LinkError);
    expect(err.message).toMatch(/private network/);
  });
});

describe("DNS rebinding regression", () => {
  let server;
  let port;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.end("INTERNAL");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => {
    lookup.mockReset();
    hits = 0;
  });

  it("checks the address the connection actually uses, so a private answer never connects", async () => {
    answer("127.0.0.1"); // the hostname "rebinds" to loopback when the socket resolves it
    await expect(requestOnce(new URL(`http://rebind.test:${port}/`))).rejects.toThrow(/private network/);
    expect(hits).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(1); // one resolution, and it is the checked one
  });

  it("readLink refuses a hostname that resolves to loopback", async () => {
    answer("127.0.0.1");
    await expect(readLink("http://localhost/")).rejects.toThrow(/private network/);
  });

  it("readLink refuses a hostname that resolves to an IPv4-mapped loopback", async () => {
    answer("::ffff:127.0.0.1");
    await expect(readLink("https://rebind.test/")).rejects.toThrow(/private network/);
  });
});

describe("URL checks before connecting", () => {
  beforeEach(resetDns);

  it.each(["http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/", "http://2130706433/"])(
    "refuses IP literal %s",
    async (url) => {
      await expect(readLink(url)).rejects.toThrow(/private network/);
      expect(lookup).not.toHaveBeenCalled();
    }
  );

  it("refuses other schemes, ports and logins", async () => {
    await expect(readLink("ftp://example.com/x")).rejects.toThrow(/Only http and https/);
    await expect(readLink("http://example.com:8080/")).rejects.toThrow(/unusual port/);
    await expect(readLink("http://u:p@example.com/")).rejects.toThrow(/username or password/);
    expect(lookup).not.toHaveBeenCalled();
  });
});
