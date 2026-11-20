/* Shared by the Vercel functions in api/. Files starting with "_" aren't deployed as routes. */

// Same Firebase project as src/firebase.js. Set in .env.local / Vercel env vars.
export const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY;

export const bearerToken = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

/* Checks a Firebase ID token with Firebase Auth. Returns the uid, or null. */
export async function verifyFirebaseToken(idToken) {
  if (!idToken) return null;
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0]?.localId ?? null;
}

/*
 * Reads one of the student's own Firestore documents through the REST API,
 * signed in as them, so firestore.rules still decide what's allowed.
 * Returns the raw REST document, or null if it doesn't exist / isn't theirs.
 */
export async function readOwnDoc(idToken, path) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!res.ok) return null;
  return res.json();
}
