// List orphaned recordings under users/{uid}/recordings/ — objects with no
// note pointing at them via audioStoragePath.
//
// READ-ONLY. This script never deletes anything, in Storage or Firestore.
// Deletion of confirmed orphans is a separate, gated decision (준현 reviews
// the list first) — do not add a --delete flag here.
//
// Usage: node scripts/audit-orphan-audio.mjs [--uid <uid>]
// Requires: .env.local with FIREBASE_SERVICE_ACCOUNT (run `vercel env pull` first)

import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config({ path: '.env.local' });

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT not in .env.local — run `vercel env pull` first');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw)),
  storageBucket: 'lazyuniv-ai.firebasestorage.app',
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

function fmtBytes(n) {
  const mb = n / (1024 * 1024);
  const gb = mb / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(2)} MB`;
}

async function auditUser(uid) {
  const prefix = `users/${uid}/recordings/`;
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) return { uid, orphans: [] };

  const notesSnap = await db.collection('users').doc(uid).collection('notes').get();
  const referenced = new Set();
  notesSnap.forEach(doc => {
    const p = doc.data().audioStoragePath;
    if (p) referenced.add(p);
  });

  const orphans = files
    .filter(f => !referenced.has(f.name))
    .map(f => ({
      path: f.name,
      bytes: Number(f.metadata.size || 0),
      timeCreated: f.metadata.timeCreated,
    }));

  return { uid, orphans };
}

async function main() {
  const uidArgIdx = process.argv.indexOf('--uid');
  const onlyUid = uidArgIdx !== -1 ? process.argv[uidArgIdx + 1] : null;

  let uids;
  if (onlyUid) {
    uids = [onlyUid];
  } else {
    const userDocs = await db.collection('users').listDocuments();
    uids = userDocs.map(d => d.id);
  }

  let grandCount = 0;
  let grandBytes = 0;

  for (const uid of uids) {
    const { orphans } = await auditUser(uid);
    if (orphans.length === 0) continue;

    console.log(`\nuser: ${uid}`);
    console.log('path'.padEnd(70), 'bytes'.padStart(12), '  timeCreated');
    for (const o of orphans) {
      console.log(o.path.padEnd(70), String(o.bytes).padStart(12), ' ', o.timeCreated);
      grandCount += 1;
      grandBytes += o.bytes;
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`orphan count: ${grandCount}`);
  console.log(`orphan total: ${grandBytes} bytes (${fmtBytes(grandBytes)})`);
  console.log('This is a READ-ONLY report — no deletion was performed.');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('audit-orphan-audio failed:', e && e.message);
  process.exit(1);
});
