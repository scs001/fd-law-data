// Object-storage session store. Only AES-GCM envelopes may cross this API;
// plaintext jars are rejected so a caller cannot accidentally persist secrets.
export function sessionObjectKey(source, accountId) {
  return `legal-sources/${encodeURIComponent(source)}/auth/${encodeURIComponent(accountId)}/session.json`;
}

export function createS3SessionStore({ s3, bucket }) {
  if (!s3 || !bucket) throw new Error("S3 session store requires s3 client and bucket");
  return {
    bucket,
    keyFor: sessionObjectKey,
    async put(envelope, { source, accountId } = {}) {
      if (!envelope || envelope.storageState || envelope.auth?.userToken) {
        throw new Error("session store rejects plaintext session jars");
      }
      const sourceId = source ?? envelope.source;
      const accountIdForPath = accountId ?? envelope.account_id;
      if (!sourceId || !accountIdForPath) {
        throw new Error("session store requires encrypted envelope source and account identity");
      }
      const key = sessionObjectKey(sourceId, accountIdForPath);
      await s3.putObject(bucket, key, JSON.stringify(envelope, null, 1), {
        contentType: "application/json",
      });
      return { key };
    },
    async get({ source, accountId }) {
      const buf = await s3.getObject(bucket, sessionObjectKey(source, accountId));
      if (!buf) return null;
      try {
        const envelope = JSON.parse(buf.toString("utf8"));
        if (envelope.storageState || envelope.auth?.userToken) {
          throw new Error("stored session is plaintext");
        }
        return { envelope };
      } catch (err) {
        if (String(err.message).includes("plaintext")) throw err;
        throw new Error(`corrupt auth session at ${sessionObjectKey(source, accountId)}: ${err.message}`);
      }
    },
  };
}
