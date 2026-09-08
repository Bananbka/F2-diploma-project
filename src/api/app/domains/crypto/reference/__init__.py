"""Reference implementation of the Mess&Gags v1 wire format.

These modules are the normative definition of the protocol. They are deliberately pure: no
database, no FastAPI, no I/O. The backend uses them only for validation (signature checks,
fingerprints); the future frontend must reproduce them exactly, and `tests/crypto/` pins the
behaviour with known-answer vectors.

Nothing here ever touches a private key belonging to a user in production — the server never
possesses one. The private-key paths exist so the reference client and the test vectors can be
generated and verified.
"""
