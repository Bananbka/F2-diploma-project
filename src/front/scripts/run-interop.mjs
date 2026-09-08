/**
 * Runs the client/backend conformance check end to end.
 *
 *   npm run interop
 *
 * Generates known-answer vectors from the Python reference inside the running api container,
 * bundles the TypeScript client (esbuild, so extensionless Angular imports resolve), and compares
 * every intermediate value.
 *
 * Requires the backend stack to be up: docker compose up -d api
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PY_VECTORS = `
import json, uuid
from app.domains.crypto.reference.identity import (
    identity_binding_message,
    prekey_binding_message,
    safety_number,
)
from app.domains.crypto.reference.ratchet import derive_message_key, advance_chain
from app.domains.crypto.reference.envelope import build_message_aad
from app.domains.crypto.reference.grants import compute_member_set_hash, distribution_signing_payload, build_grant_aad
from app.domains.crypto.reference.channel import channel_post_payload
from app.domains.crypto.reference.primitives import b64u_encode

USER = '11111111-1111-1111-1111-111111111111'
DEV = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
CHAT = '33333333-3333-3333-3333-333333333333'
SKID = '77777777-7777-7777-7777-777777777777'
RDEV = '99999999-9999-9999-9999-999999999999'
POST = '55555555-5555-5555-5555-555555555555'

ck = bytes(range(32))
k32 = bytes(range(100, 132))
mk, nonce = derive_message_key(ck)

print(json.dumps({
    'message_key': b64u_encode(mk),
    'nonce': b64u_encode(nonce),
    'next_chain_key': b64u_encode(advance_chain(ck)),
    'msg_aad': b64u_encode(build_message_aad(uuid.UUID(CHAT), 5, uuid.UUID(USER), uuid.UUID(SKID), 42)),
    'binding': b64u_encode(identity_binding_message(uuid.UUID(USER), uuid.UUID(DEV), k32)),
    'member_set_hash': compute_member_set_hash([DEV, RDEV, CHAT]),
    'dist_payload': b64u_encode(distribution_signing_payload(uuid.UUID(CHAT), 7, uuid.UUID(SKID), k32, 3)),
    'grant_aad': b64u_encode(build_grant_aad(chat_id=uuid.UUID(CHAT), epoch=3, sender_key_id=uuid.UUID(SKID),
                                             sender_device_id=uuid.UUID(DEV), recipient_device_id=uuid.UUID(RDEV),
                                             ephemeral_public=k32)),
    'post_payload': b64u_encode(channel_post_payload(uuid.UUID(CHAT), uuid.UUID(USER), uuid.UUID(POST),
                                                     'Release 2.0 ships on Friday.')),
    'safety_number': safety_number(k32, bytes(range(200, 232))),
    'prekey_binding': b64u_encode(prekey_binding_message(uuid.UUID(USER), uuid.UUID(DEV), k32)),
}))
`;

const work = mkdtempSync(join(tmpdir(), 'ns-interop-'));

try {
    const scriptPath = join(work, 'gen_vectors.py');
    writeFileSync(scriptPath, PY_VECTORS);

    console.log('Generating vectors from the Python reference...');
    const vectors = execFileSync(
        'docker',
        ['compose', 'exec', '-T', 'api', 'python', '-c', PY_VECTORS],
        { cwd: join(process.cwd(), '..'), encoding: 'utf8' }
    ).trim();

    console.log('Bundling the TypeScript client...');
    const bundlePath = join(work, 'client.mjs');
    execFileSync(
        'npx',
        [
            'esbuild',
            'scripts/interop-check.mjs',
            '--bundle',
            '--platform=node',
            '--format=esm',
            `--outfile=${bundlePath}`,
            '--log-level=error',
        ],
        { stdio: 'inherit', shell: process.platform === 'win32' }
    );

    console.log('\nComparing implementations:\n');
    execFileSync('node', [bundlePath, vectors], { stdio: 'inherit' });
} catch (error) {
    console.error('\nInterop check failed.');
    if (error.status === undefined) {
        console.error('Is the backend up?  docker compose up -d api');
    }
    process.exit(1);
} finally {
    rmSync(work, { recursive: true, force: true });
}
