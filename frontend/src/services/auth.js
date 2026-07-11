// Zero-knowledge local accounts.
//
// Email + password sign-in where the password NEVER leaves the device and the
// user's training history is AES-256-GCM encrypted at rest with a key derived
// from the password (PBKDF2, 150k iterations, SHA-256). On a shared machine,
// another user — or anyone reading localStorage — sees only ciphertext.
// There is no server, no account database, nothing to breach.

const ACC_KEY = "formcoach.accounts";
const VAULT_PREFIX = "formcoach.vault.";
const TAB_KEY = "formcoach.tabKey"; // sessionStorage: survives reload, dies with the tab

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let user = null;   // signed-in email
let aesKey = null; // CryptoKey for this user's vault

const accounts = () => JSON.parse(localStorage.getItem(ACC_KEY) || "{}");

async function pbkdf2(password, salt, info) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(info + salt), iterations: 150_000, hash: "SHA-256" },
    base,
    256
  );
}

const importAes = (bits) =>
  crypto.subtle.importKey("raw", bits, "AES-GCM", true, ["encrypt", "decrypt"]);

export const currentUser = () => user;

export async function register(email, password) {
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");
  const all = accounts();
  if (all[email]) throw new Error("Account already exists — sign in instead.");
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  all[email] = { salt, verifier: b64(await pbkdf2(password, salt, "verify:")) };
  localStorage.setItem(ACC_KEY, JSON.stringify(all));
  return signIn(email, password);
}

export async function signIn(email, password) {
  email = email.trim().toLowerCase();
  const acc = accounts()[email];
  if (!acc) throw new Error("No account with that email — create one first.");
  if (b64(await pbkdf2(password, acc.salt, "verify:")) !== acc.verifier) {
    throw new Error("Wrong password.");
  }
  const bits = await pbkdf2(password, acc.salt, "data:");
  aesKey = await importAes(bits);
  user = email;
  sessionStorage.setItem(TAB_KEY, JSON.stringify({ email, key: b64(bits) }));
  return email;
}

// Restore the signed-in state after a reload (same tab only).
export async function resume() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TAB_KEY));
    if (!t) return null;
    aesKey = await importAes(unb64(t.key).buffer);
    user = t.email;
    return user;
  } catch {
    return null;
  }
}

export function signOut() {
  user = null;
  aesKey = null;
  sessionStorage.removeItem(TAB_KEY);
}

// Load the current user's session history. Guests use the legacy plain store.
export async function loadVault() {
  if (!user) {
    try { return JSON.parse(localStorage.getItem("formcoach.sessions")) || []; } catch { return []; }
  }
  const raw = localStorage.getItem(VAULT_PREFIX + user);
  if (!raw) return [];
  try {
    const { iv, ct } = JSON.parse(raw);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, aesKey, unb64(ct));
    return JSON.parse(dec.decode(plain));
  } catch {
    return [];
  }
}

export async function saveVault(sessions) {
  const json = JSON.stringify(sessions);
  if (!user) {
    localStorage.setItem("formcoach.sessions", json);
    return;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(json));
  localStorage.setItem(VAULT_PREFIX + user, JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
}
