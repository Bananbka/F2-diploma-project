import json
import uuid

import botocore
from aiobotocore.session import get_session
from app.core.config import settings


class MinioClient:
    def __init__(self):
        self.session = get_session()
        self.endpoint_url = settings.MINIO_URL
        self.access_key = settings.MINIO_USER
        self.secret_key = settings.MINIO_PASSWORD
        self.buckets = [
            settings.MINIO_MESSAGE_BUCKET,
            settings.MINIO_AVATAR_BUCKET
        ]

    def get_client(self):
        return self.session.create_client(
            's3',
            region_name='us-east-1',
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key
        )

    async def ensure_bucket_exists(self):
        async with self.get_client() as client:
            for bucket_name in self.buckets:
                try:
                    await client.head_bucket(Bucket=bucket_name)
                except botocore.exceptions.ClientError as e:
                    error_code = e.response['Error']['Code']
                    if error_code == '404':
                        print(f'Bucket {bucket_name} does not exist. Creating new bucket...')
                        await client.create_bucket(Bucket=bucket_name)

                        if bucket_name == settings.MINIO_AVATAR_BUCKET:
                            policy = {
                                "Version": "2012-10-17",
                                "Statement": [
                                    {
                                        "Sid": "PublicReadGetObject",
                                        "Effect": "Allow",
                                        "Principal": "*",
                                        "Action": ["s3:GetObject"],
                                        "Resource": [f"arn:aws:s3:::{bucket_name}/*"]
                                    }
                                ]
                            }
                            await client.put_bucket_policy(Bucket=bucket_name, Policy=json.dumps(policy))
                            print(f'Set public policy for {bucket_name}')
                    else:
                        raise e

    async def upload_file(self, file_bytes: bytes, original_filename: str, content_type: str,
                          bucket_name: str) -> str:
        file_extension = original_filename.split(".")[-1] if "." in original_filename else "enc"
        unique_filename = f"{uuid.uuid4()}.{file_extension}"

        async with self.get_client() as client:
            await client.put_object(
                Bucket=bucket_name,
                Key=unique_filename,
                Body=file_bytes,
                ContentType=content_type
            )

            file_url = f"{self.endpoint_url}/{bucket_name}/{unique_filename}"
            return file_url

    async def stream_object(self, object_key: str, bucket_name: str):
        """Open an object for reading. Yields (body_stream, content_type, content_length).

        A read path is needed at all because the message bucket carries no public-read policy —
        deliberately, since anonymous GET on ciphertext would leak size and access patterns to anyone
        holding a URL. Authorisation therefore has to happen in the API, which means the bytes come
        back through it rather than straight from MinIO.
        """
        async with self.get_client() as client:
            response = await client.get_object(Bucket=bucket_name, Key=object_key)
            body = await response["Body"].read()

        return body, response.get("ContentType", "application/octet-stream"), len(body)

    async def delete_file(self, file_url: str, bucket_name) -> str:
        try:
            filename = file_url.split("/")[-1]

            async with self.get_client() as client:
                await client.delete_object(Bucket=bucket_name, Key=filename)
        except Exception as e:
            print("ERROR WHILE DELETING FILE: ", e)


minio_manager = MinioClient()
