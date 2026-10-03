/** Check the user's T3 session, never the sidecar's administrative credential. */
export async function browserIsAuthorized(headers, origin, fetchImpl = fetch) {
  if (!headers.cookie && !headers.authorization) return false;
  try {
    const response = await fetchImpl(new URL("/api/auth/session", origin), {
      headers: {
        ...(headers.cookie ? { Cookie: headers.cookie } : {}),
        ...(headers.authorization ? { Authorization: headers.authorization } : {}),
      },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok && (await response.json()).authenticated === true;
  } catch {
    return false;
  }
}
