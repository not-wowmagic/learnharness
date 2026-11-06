/** Liveness probe for the hosted container. No workspace, no auth, no IO. */
export const dynamic = "force-dynamic";

export function GET(): Response {
	return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
