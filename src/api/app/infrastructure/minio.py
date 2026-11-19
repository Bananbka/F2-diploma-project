import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import botocore
from aiobotocore.session import get_session

from app.core.config import settings


# Chunk size for streamed reads: large enough that a 50 MB object is ~800 chunks rather than the
# ~50,000 aiobotocore's 1 KB default would produce, small enough that the per-request memory held
# at any moment is negligible.
OBJECT_STREAM_CHUNK_BYTES = 64 * 1024


@dataclass(slots=True)
class OpenObject:
    """An object whose headers have been received but whose body has not been read yet.

    `content_length` comes from the store's response headers, so a caller can decide whether it is
    willing to read the body at all *before* a single byte of it is in memory.
    """

    body: Any
    content_type: str
    content_length: int

    async def iter_chunks(
        self, chunk_size: int = OBJECT_STREAM_CHUNK_BYTES
    ) -> AsyncIterator[bytes]:
        async for chunk in self.body.iter_chunks(chunk_size):
            yield chunk

    async def read(self) -> bytes:
        return await self.body.read()


class MinioClient:
    def __init__(self):
        self.session = get_session()
        self.endpoint_url = settings.MINIO_URL
        self.access_key = settings.MINIO_USER
        self.secret_key = settings.MINIO_PASSWORD
        self.buckets = [
            settings.MINIO_MESSAGE_BUCKET,
            settings.MINIO_AVATAR_BUCKET,
            settings.MINIO_STICKER_BUCKET,
        ]

    def get_client(self):
        return self.session.create_client(
            "s3",
            region_name="us-east-1",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
        )

    async def ensure_bucket_exists(self):
        async with self.get_client() as client:
            for bucket_name in self.buckets:
                try:
                    await client.head_bucket(Bucket=bucket_name)
                except botocore.exceptions.ClientError as e:
                    error_code = e.response["Error"]["Code"]
                    if error_code == "404":
                        print(
                            f"Bucket {bucket_name} does not exist. Creating new bucket..."
                        )
                        await client.create_bucket(Bucket=bucket_name)

                        if bucket_name in (
                            settings.MINIO_AVATAR_BUCKET,
                            settings.MINIO_STICKER_BUCKET,
                        ):
                            policy = {
                                "Version": "2012-10-17",
                                "Statement": [
                                    {
                                        "Sid": "PublicReadGetObject",
                                        "Effect": "Allow",
                                        "Principal": "*",
                                        "Action": ["s3:GetObject"],
                                        "Resource": [f"arn:aws:s3:::{bucket_name}/*"],
                                    }
                                ],
                            }
                            await client.put_bucket_policy(
                                Bucket=bucket_name, Policy=json.dumps(policy)
                            )
                            print(f"Set public policy for {bucket_name}")
                    else:
                        raise e

    async def get_object_owner(
        self, object_key: str, bucket_name: str
    ) -> tuple[bool, str | None]:
        """Returns `(exists, owner_id)` for one object.

        Ownership has to be recorded somewhere, because the attachment url on a message is
        entirely client-supplied: without this, naming someone else's object key in your own
        message was enough to make it downloadable through your own chat.

        Two return values rather than one, because "no object" and "an object with no recorded
        owner" are different situations and must not be conflated. Objects uploaded before
        ownership was recorded have no `owner-id`, and collapsing both cases to `None` would have
        made every one of them permanently unforwardable with a misleading "no longer exists".
        """
        try:
            async with self.get_client() as client:
                response = await client.head_object(Bucket=bucket_name, Key=object_key)
        except botocore.exceptions.ClientError:
            return False, None

        return True, (response.get("Metadata") or {}).get("owner-id")

    async def upload_file(
        self,
        file_bytes: bytes,
        original_filename: str,
        content_type: str,
        bucket_name: str,
        force_octet_stream: bool = False,
        owner_id: str | None = None,
        public: bool = False,
    ) -> str:
        """Store one object under a server-generated key.

        The extension is derived from the client's filename, so it is sanitised: taking the last
        dot-segment verbatim let a name like `a.b/../x` produce a key containing `/`, which the
        attachment-url validator then rejects — leaving an object nothing could ever reference,
        download or delete.

        `public` selects which base the returned `file_url` is built from. The S3 client itself
        always talks to `self.endpoint_url` (the compose-network hostname) to actually reach the
        store — that part never changes. But avatars and stickers are rendered directly as
        `<img src>` in the browser, which cannot resolve that hostname, so for those two buckets
        the *returned, stored* url needs to be the browser-reachable `MINIO_PUBLIC_URL` instead.
        Message-bucket attachments are never rendered as a raw url (the client always fetches them
        through the authenticated download proxy), so they stay on the internal base.
        """
        extension = (
            original_filename.rsplit(".", 1)[-1] if "." in original_filename else "enc"
        )
        extension = "".join(c for c in extension if c.isalnum())[:10].lower() or "enc"

        unique_filename = f"{uuid.uuid4()}.{extension}"

        async with self.get_client() as client:
            await client.put_object(
                Bucket=bucket_name,
                Key=unique_filename,
                Body=file_bytes,
                ContentType="application/octet-stream"
                if force_octet_stream
                else content_type,
                Metadata={"owner-id": owner_id} if owner_id else {},
            )

            base_url = settings.MINIO_PUBLIC_URL if public else self.endpoint_url
            file_url = f"{base_url}/{bucket_name}/{unique_filename}"
            return file_url

    @asynccontextmanager
    async def open_object(
        self, object_key: str, bucket_name: str
    ) -> AsyncIterator[OpenObject]:
        """Open an object for reading without reading it.

        A read path is needed at all because the message bucket carries no public-read policy —
        deliberately, since anonymous GET on ciphertext would leak size and access patterns to anyone
        holding a URL. Authorisation therefore has to happen in the API, which means the bytes come
        back through it rather than straight from MinIO.

        Yields once the store has answered with headers; the body is still on the wire. The caller
        either streams it (`iter_chunks`), reads it (`read`), or leaves the block without touching
        it, in which case the connection is dropped and the body never enters this process. The
        client and the response are both released when the block exits, on every path.
        """
        async with self.get_client() as client:
            response = await client.get_object(Bucket=bucket_name, Key=object_key)
            async with response["Body"] as _:
                yield OpenObject(
                    body=response["Body"],
                    content_type=response.get("ContentType", "application/octet-stream"),
                    content_length=int(response.get("ContentLength") or 0),
                )

    async def stream_object(self, object_key: str, bucket_name: str):
        """Read a whole object into memory. Returns (body, content_type, content_length).

        Only for objects with a small, server-enforced size cap (the appearance background image).
        Anything that can be attachment-sized must go through `open_object` and be streamed or
        size-checked first — buffering those here is what let one request hold gigabytes.
        """
        async with self.open_object(object_key, bucket_name) as obj:
            body = await obj.read()
            return body, obj.content_type, len(body)

    async def put_object_at(
        self, key: str, body: bytes, content_type: str, bucket_name: str, owner_id: str | None = None
    ) -> None:
        """Store one object under a caller-chosen key, overwriting any existing one.

        Never returns a URL: objects stored this way are private and only ever served by an API
        endpoint that authorises the caller.
        """
        async with self.get_client() as client:
            await client.put_object(
                Bucket=bucket_name,
                Key=key,
                Body=body,
                ContentType=content_type,
                Metadata={"owner-id": owner_id} if owner_id else {},
            )

    async def delete_key(self, key: str, bucket_name: str) -> None:
        """Delete one object by its exact key. Never raises: a missing object is already deleted."""
        try:
            async with self.get_client() as client:
                await client.delete_object(Bucket=bucket_name, Key=key)
        except Exception as e:
            print("ERROR WHILE DELETING OBJECT: ", e)

    async def delete_file(self, file_url: str, bucket_name) -> str:
        try:
            filename = file_url.split("/")[-1]

            async with self.get_client() as client:
                await client.delete_object(Bucket=bucket_name, Key=filename)
        except Exception as e:
            print("ERROR WHILE DELETING FILE: ", e)


minio_manager = MinioClient()
