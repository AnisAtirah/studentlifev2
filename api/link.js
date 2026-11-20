import { bearerToken, readOwnDoc, verifyFirebaseToken } from "./_auth.js";
import { LinkError, readLink } from "./_readLink.js";

/*
 * POST /api/link
 * Opens one link saved in the student's course folder and returns its text,
 * so an agent can read lecture notes, slides and past papers.
 *
 * Body:     { courseId, linkId, part }
 * Header:   Authorization: Bearer <Firebase ID token>
 * Response: { label, url, kind, title, part, parts, text }  or  { error }
 *
 * The browser never sends a URL: the link is looked up in the student's own
 * course document, so this can't be used to fetch arbitrary websites.
 */

const ID_RE = /^[\w-]{1,128}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  const token = bearerToken(req);
  const uid = await verifyFirebaseToken(token);
  if (!uid) return res.status(401).json({ error: "Please sign in again." });

  const { courseId, linkId, part = 1 } = req.body || {};
  if (!ID_RE.test(courseId || "") || !ID_RE.test(linkId || "") || !Number.isInteger(part) || part < 1) {
    return res.status(400).json({ error: "Bad link reference." });
  }

  const course = await readOwnDoc(token, `users/${uid}/courses/${courseId}`);
  const links = course?.fields?.links?.arrayValue?.values || [];
  const link = links
    .map((v) => v.mapValue?.fields || {})
    .find((f) => f.id?.stringValue === linkId);
  const url = link?.url?.stringValue;
  if (!url) return res.status(404).json({ error: "That link isn't in this course anymore." });

  try {
    const result = await readLink(url, part);
    return res.status(200).json({ label: link.label?.stringValue || "", url, ...result });
  } catch (err) {
    if (err instanceof LinkError) return res.status(422).json({ error: err.message });
    console.error("Link read failed", err);
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return res.status(502).json({ error: timedOut ? "That website took too long to answer." : "Couldn't open that link." });
  }
}
