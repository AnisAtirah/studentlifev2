import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";
import { extractText, getDocumentProxy } from "unpdf";

/*
 * Opens a course link (lecture notes, slides, past papers...) and returns its
 * text so an agent can read it. Server-only. Files in api/ starting with "_"
 * are helpers, not Vercel functions.
 *
 * Google Docs/Slides/Sheets/Drive links are rewritten to their export address,
 * which works when the file is shared as "Anyone with the link can view".
 */

export const PART_CHARS = 30_000; // ~7-8k tokens per read
const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

export class LinkError extends Error {}

/* Where to actually download a link from, and what kind of file it is. */
export function exportUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.replace(/^www\./, "");
  const id = (re) => url.pathname.match(re)?.[1];

  if (host === "docs.google.com") {
    let d;
    if ((d = id(/\/document\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { url: `https://docs.google.com/document/d/${d}/export?format=txt`, kind: "Google Doc" };
    if ((d = id(/\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { url: `https://docs.google.com/presentation/d/${d}/export/pdf`, kind: "Google Slides" };
    if ((d = id(/\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { url: `https://docs.google.com/spreadsheets/d/${d}/export?format=csv`, kind: "Google Sheet" };
  }
  if (host === "drive.google.com") {
    if (/\/drive\/(?:u\/\d+\/)?folders\//.test(url.pathname)) {
      throw new LinkError("This is a Drive folder. Folders can't be opened; add links to the files inside it instead.");
    }
    const d = id(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/) || url.searchParams.get("id");
    if (d) return { url: `https://drive.google.com/uc?export=download&id=${d}`, kind: "Drive file" };
  }
  return { url: url.toString(), kind: "web page" };
}

/*
 * Addresses the server must never connect to: loopback, private networks,
 * link-local (cloud metadata), carrier-grade NAT, NAT64, multicast, reserved
 * and documentation ranges.
 */
const BLOCKED_V4 = new BlockList();
[
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].forEach(([net, bits]) => BLOCKED_V4.addSubnet(net, bits, "ipv4"));

const BLOCKED_V6 = new BlockList();
[
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
  ["64:ff9b::", 96], ["2001:db8::", 32], ["ff00::", 8],
].forEach(([net, bits]) => BLOCKED_V6.addSubnet(net, bits, "ipv6"));

/* The 8 16-bit words of a valid IPv6 address (dotted IPv4 tails included). */
function ipv6Words(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? null : tail ? tail.split(":") : [];
  const words = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return words.map((w) => parseInt(w, 16));
}

/* IPv4 hidden inside an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) IPv6 address. */
function embeddedIPv4(ip) {
  const w = ipv6Words(ip);
  if (w.slice(0, 5).some((x) => x !== 0) || (w[5] !== 0 && w[5] !== 0xffff)) return null;
  return `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
}

/* Blocks addresses inside private networks, so the server can't be pointed at itself. */
export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(ip);
    return v4 ? BLOCKED_V4.check(v4, "ipv4") : BLOCKED_V6.check(ip, "ipv6");
  }
  return true; // not an IP address at all: never connect
}

/*
 * DNS lookup used for the connection itself. Because the check happens here,
 * the address that passes it is the address the socket connects to; a hostname
 * can't answer "public" to a check and "private" to the connection (DNS rebinding).
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === "function") [callback, options] = [options, {}];
  const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
  lookup(hostname, { all: true, family }, (err, addresses) => {
    if (err || !addresses?.length) return callback(new LinkError("That website couldn't be found."));
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new LinkError("That link points to a private network address."));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function checkPublicUrl(url) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LinkError("Only http and https links can be opened.");
  if (url.port && url.port !== "443" && url.port !== "80") throw new LinkError("That link uses an unusual port and can't be opened.");
  if (url.username || url.password) throw new LinkError("Links with a username or password can't be opened.");
  // Node skips the lookup for IP literals, so check those here. Hostnames are checked by safeLookup.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) throw new LinkError("That link points to a private network address.");
}

/* One GET with no redirect following and no connection reuse (every hop gets a fresh, checked lookup). */
export function requestOnce(url) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: "GET",
      agent: false,
      lookup: safeLookup,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "StudentLife-link-reader/1.0",
        Accept: "text/html,text/plain,application/pdf,*/*;q=0.5",
        "Accept-Encoding": "gzip, br, identity",
      },
    }, resolve);
    req.on("error", reject);
    req.end();
  });
}

function toLinkError(err) {
  if (err instanceof LinkError) return err;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return new LinkError("That website took too long to answer.");
  return new LinkError("That website couldn't be reached.");
}

/* Reads (and decompresses) the body, stopping at MAX_BYTES of decompressed data. */
async function readBody(res) {
  const encoding = String(res.headers["content-encoding"] || "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
    : encoding === "deflate" ? zlib.createInflate()
    : encoding === "br" ? zlib.createBrotliDecompress()
    : null;
  const stream = decoder ? res.pipe(decoder) : res;
  if (decoder) res.on("error", (err) => decoder.destroy(err));

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new LinkError("That file is too big to read (over 15 MB).");
      chunks.push(chunk);
    }
  } catch (err) {
    res.destroy();
    throw toLinkError(err);
  }
  return Buffer.concat(chunks);
}

/* GET that re-checks every redirect and stops at a size limit. */
async function download(start) {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkPublicUrl(url);
    let res;
    try {
      res = await requestOnce(url);
    } catch (err) {
      throw toLinkError(err);
    }
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      url = new URL(res.headers.location, url);
      if (url.hostname === "accounts.google.com") {
        throw new LinkError("This Google file isn't public. In Google Drive, set sharing to “Anyone with the link can view”, then try again.");
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      if (status === 401 || status === 403) throw new LinkError("That link needs a login, so it can't be opened. Share it publicly or upload a public copy.");
      if (status === 404) throw new LinkError("That link doesn't exist anymore (404).");
      throw new LinkError(`The website answered with an error (${status}).`);
    }
    const bytes = await readBody(res);
    return { bytes, type: String(res.headers["content-type"] || "").toLowerCase(), finalUrl: url };
  }
  throw new LinkError("That link redirects too many times.");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/* Good-enough HTML to text: drops scripts and styles, keeps line breaks between blocks. */
export function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return { title, text };
}

const tidy = (s) => s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/*
 * Reads a link and returns one part of its text:
 *   { kind, title, part, parts, text }
 * Throws LinkError with a message for the student when it can't.
 */
export async function readLink(rawUrl, part = 1) {
  let target;
  try {
    target = exportUrl(rawUrl);
  } catch (err) {
    if (err instanceof LinkError) throw err;
    throw new LinkError("That doesn't look like a valid link.");
  }
  const { bytes, type } = await download(target.url);

  let title = "";
  let text;
  let kind = target.kind;
  if (type.includes("application/pdf") || bytes.subarray(0, 5).toString() === "%PDF-") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
    text = pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join("\n\n");
    if (kind === "web page" || kind === "Drive file") kind = `PDF, ${totalPages} pages`;
  } else if (type.includes("text/html")) {
    if (kind === "Drive file" && /virus scan|can't scan this file/i.test(bytes.toString("utf8", 0, 20000))) {
      throw new LinkError("That Drive file is too large for Google to preview, so it can't be read.");
    }
    ({ title, text } = htmlToText(bytes.toString("utf8")));
  } else if (type.startsWith("text/") || type.includes("json") || type.includes("csv") || kind.startsWith("Google")) {
    text = bytes.toString("utf8").replace(/^﻿/, "");
  } else {
    throw new LinkError(`That file type (${type.split(";")[0] || "unknown"}) can't be read yet. PDFs, Google Docs/Slides/Sheets and web pages work.`);
  }

  text = tidy(text);
  if (!text) throw new LinkError("That file has no readable text (it may be scanned images).");
  const parts = Math.max(1, Math.ceil(text.length / PART_CHARS));
  const n = Math.min(Math.max(1, part | 0), parts);
  return { kind, title, part: n, parts, text: text.slice((n - 1) * PART_CHARS, n * PART_CHARS) };
}
