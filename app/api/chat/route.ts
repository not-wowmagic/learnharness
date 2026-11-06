import { admitHostedChat, handleChatRequest, withWorkspace } from "@/src/server";

async function POSTHandler(req: Request) {
	const admission = await admitHostedChat(req);
	if (!admission.ok) {
		return Response.json(admission.body, {
			status: admission.status,
			headers: admission.body.retryAfterSeconds
				? { "Retry-After": String(admission.body.retryAfterSeconds) }
				: undefined,
		});
	}
	return handleChatRequest(req);
}

export const POST = withWorkspace(POSTHandler);
