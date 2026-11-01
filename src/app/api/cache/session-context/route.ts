import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getDefaultSessionContextStore } from "@omniroute/open-sse/services/claudeSessionContextFreeze.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export const dynamic = "force-dynamic";

/**
 * ZAC-272 (homelab): drop one chat's frozen <session_context> block so its next call
 * sends the current one. `session` is the chat's session-state folder name (its id).
 * DELETE /api/cache/session-context?session=<id> (management auth: key, dashboard or the
 * loopback CLI token).
 */
export async function DELETE(req: NextRequest) {
  const authError = await requireManagementAuth(req);
  if (authError) return authError;
  const session = new URL(req.url).searchParams.get("session")?.trim();
  if (!session || !/^[A-Za-z0-9._-]{1,128}$/.test(session)) {
    return NextResponse.json(
      { error: "session must be a session-state folder name" },
      { status: 400 }
    );
  }
  try {
    const removed = getDefaultSessionContextStore().deleteSession(session);
    return NextResponse.json({ ok: true, session, removed });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
