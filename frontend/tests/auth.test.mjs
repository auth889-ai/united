// Zero-knowledge auth test suite — run with: node frontend/tests/auth.test.mjs
// Verifies: registration, sign-in, wrong-password rejection, per-user data
// isolation, and that vault contents are actually encrypted at rest.

const mkStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => [...m.entries()].map(([k, v]) => k + "=" + v).join("\n"),
  };
};
globalThis.localStorage = mkStore();
globalThis.sessionStorage = mkStore();

const auth = await import("../src/services/auth.js");

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${name}`);
  if (!cond) failures++;
};
const throws = async (fn) => { try { await fn(); return false; } catch { return true; } };

// register + save data for alice
await auth.register("alice@example.com", "hunter22");
check("register signs in", auth.currentUser() === "alice@example.com");
await auth.saveVault([{ exercise: "Squat", reps: 12, avgScore: 91 }]);
check("vault roundtrip", (await auth.loadVault())[0].reps === 12);

// data is encrypted at rest — plaintext never touches localStorage
check("vault is ciphertext (no plaintext at rest)", !localStorage._dump().includes("Squat"));
check("password not stored anywhere", !localStorage._dump().includes("hunter22"));

// isolation: bob cannot see alice's data
auth.signOut();
check("sign out clears identity", auth.currentUser() === null);
check("guest sees no private data", (await auth.loadVault()).length === 0);
await auth.register("bob@example.com", "secret99");
check("bob's vault is empty (isolation)", (await auth.loadVault()).length === 0);

// auth failures
auth.signOut();
check("wrong password rejected", await throws(() => auth.signIn("alice@example.com", "wrong")));
check("unknown email rejected", await throws(() => auth.signIn("nobody@example.com", "x")));
check("duplicate register rejected", await throws(() => auth.register("alice@example.com", "hunter22")));
check("weak password rejected", await throws(() => auth.register("new@example.com", "123")));

// alice signs back in and still has her data
await auth.signIn("alice@example.com", "hunter22");
check("alice's data survives sign-out/in", (await auth.loadVault())[0].avgScore === 91);

console.log(failures ? `\n${failures} test(s) FAILED` : "\nALL AUTH TESTS PASS");
process.exit(failures ? 1 : 0);
