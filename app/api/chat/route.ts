import { handleChatRequest, withWorkspace } from "@/src/server";

async function POSTHandler(req: Request) {
	return handleChatRequest(req);
}

export const POST = withWorkspace(POSTHandler);
